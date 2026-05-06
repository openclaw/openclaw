# Phase: entry-auth-gate — Research

**Researched:** 2026-04-18
**Domain:** CLI entry-point security gate for forcing read-only auth store during `secrets audit`
**Confidence:** HIGH

## Summary

`src/entry.ts:22-30` argv-sniffs adjacent tokens `secrets audit` and sets `OPENCLAW_AUTH_STORE_READONLY=1` before any CLI code loads. The guarantee is semantic (the audit command must never mutate credentials) but the mechanism is lexical (string match on argv). Any rename, alias, or insertion of an option between the two tokens silently drops the guarantee — a security regression.

The two env consumers both read `process.env` at function-call time, not module-load time, which is a key architectural opening: **the env does not need to be set before imports settle**, only before the consumers run. That unlocks action-time or pre-parse hook approaches alongside the manifest approach.

**Primary recommendation:** Approach A (exported command-path manifest) — most surgical, zero risk to cold-path cost, rename-breaks-build safety. Approach C (lazy-read plus preaction hook) is the cleanest long-term but broadens scope. Approach B (Commander dry-parse pre-dispatch) carries subtle cost and edge-case risk (help, error paths) for little gain over A.

## Question 1 — How is `secrets audit` registered?

**Framework:** Commander.js (confirmed at `src/cli/program/build-program.ts:2` — `import { Command } from "commander"`).

**Exact registration site:** `src/cli/secrets-cli.ts:84-93`

```ts
  secrets
    .command("audit")
    .description("Audit plaintext secrets, unresolved refs, and precedence drift")
    .option("--check", "Exit non-zero when findings are present", false)
    .option(
      "--allow-exec",
      "Allow exec SecretRef resolution during audit (may execute provider commands)",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (opts: SecretsAuditOptions) => {
```

Parent `secrets` command is defined on the same file at `src/cli/secrets-cli.ts:46-54` (`.command("secrets")`). The subcli is registered lazily through `src/cli/program/register.subclis-core.ts:206-210`:

```ts
    {
      commandNames: ["secrets"],
      loadModule: () => import("../secrets-cli.js"),
      exportName: "registerSecretsCli",
    },
```

So the registration chain is: `build-program.ts` → `registerProgramCommands` → lazy dynamic import of `secrets-cli.ts` → `registerSecretsCli(program)` → `.command("secrets").command("audit")`.

## Question 2 — Ordering constraint (module-load vs call-time)

**Both consumers read env at call-time, NOT at module-load.** This is the key architectural fact.

- `src/agents/auth-profiles/store.ts:230` — inside a function body (`loadAuthProfileStore` scope), specifically after `mergeOAuthFileIntoStore(store)`. Grep confirms this is the ONLY `process.env.OPENCLAW_AUTH_STORE_READONLY` reference in the file. No top-level const capture.
- `src/agents/pi-model-discovery.ts:155-158` — inside the exported function `scrubLegacyStaticAuthJsonEntriesForDiscovery`. First statement of the function body.

**Implication:** The env variable does not need to be set before module imports resolve. It only needs to be set before `loadAuthProfileStore` or `scrubLegacyStaticAuthJsonEntriesForDiscovery` is called. This allows action-time hooks (Commander `preAction`) or command-action prologues to set it, not just the pre-import gate currently in entry.ts.

**Caveat — why entry.ts still sets it early:** The argv-sniff happens at `src/entry.ts:60-62` before `runCli` is invoked via `./cli/run-main.js` at line 204. This defends against any future code path that captures the env at module-load. Preserving pre-parse timing is safer as a defense-in-depth choice even though it is not strictly required today.

## Question 3 — Commander hook and metadata support

Commander.js supports three relevant seams already in use here:

1. **`program.hook("preAction", fn)`** — registered via `registerPreActionHooks(program, ctx.programVersion)` at `src/cli/program/build-program.ts:24` (implementation at `src/cli/program/preaction.ts`). This fires after argv parsing, after the final action command is resolved, but before its `.action()` runs. It receives `(thisCommand, actionCommand)` and can walk up `actionCommand.parent` to build a full command path — exactly what `setProcessTitleForCommand` does at `preaction.ts:19-30`.
2. **`command.parseOptions(argv)` / `program.parse(argv, { from: "user" })`** — Commander can be asked to resolve the selected command without executing the action, but error/help paths complicate this and no existing code does it.
3. **Custom metadata on `Command` instances** — Commander exposes no first-class metadata API, but the repo already attaches per-command data via closures (see `setProgramContext` at `build-program.ts:22`) and via a parallel descriptor catalog (`subCliCommandCatalog` at `src/cli/program/subcli-descriptors.ts:7`). Commander `Command` objects also accept arbitrary property attachment, though the repo does not do this today.

The preAction hook is the most idiomatic seam for command-driven env — it already exists, already receives the resolved command tree, and already mutates process state (`process.title`).

## Question 4 — Existing pattern for command-metadata-driven env

**No existing pattern sets env from command metadata.** Every `process.env.OPENCLAW_*` write in `src/cli/program/**` is either:

- Test-only env manipulation (`private-qa-cli.test.ts`, `preaction.test.ts`, `register.subclis.test.ts`).
- A generic runtime toggle, not tied to a specific command identity (e.g., `config-guard.ts:57-67` temporarily sets `OPENCLAW_SUPPRESS_NOTES` around a block).

The closest architectural precedent is **`command-startup-policy.ts`** (referenced from `preaction.ts:12` as `shouldBypassConfigGuardForCommandPath`) — a function that takes a resolved command path and returns a policy decision. This is the shape to mirror: a pure predicate over command path, called from a single hook site.

There is also a precedent for **parallel descriptor catalogs** (`subcli-descriptors.ts:7`, `command-descriptor-utils.ts`) where command metadata lives next to — but not inside — the Commander `Command` instance. A read-only-commands manifest would slot naturally alongside this.

**Verdict:** No drop-in pattern; closest analogs are `shouldBypassConfigGuardForCommandPath` (predicate shape) and `subCliCommandCatalog` (metadata shape). A new manifest would be the first of its kind for env-gating.

## Question 5 — Approach candidates

### Approach A — Exported command-path manifest (RECOMMENDED)

Add `export const READ_ONLY_AUTH_COMMAND_PATHS: readonly (readonly string[])[] = [["secrets", "audit"]]` to `src/cli/secrets-cli.ts` (or a sibling `secrets-cli.read-only-paths.ts` to avoid dragging Commander into entry.ts's dependency graph). Replace the argv-sniff in entry.ts with a loop over the manifest using the same structural match (tokens-only filter). The manifest lives next to the command definition, so a rename of `audit` forces whoever touches `.command("audit")` to also touch the manifest line — if they don't, the TypeScript build still succeeds but the test suite's existing coverage in `src/cli/secrets-cli.test.ts` and `src/secrets/audit.test.ts` (plus a new "manifest matches registered command" test) catches the drift.

**Trade-off:** Still structural/lexical matching on argv (no real parse), but failure mode shifts from silent-security-regression to loud-test-failure, and the manifest sits in the secrets module so accidental divergence is unlikely.

### Approach B — Commander dry-parse to resolve the selected command

Build the program (or a minimal skeleton), call `program.parseOptions` / partial parse to determine the actionCommand, check for a metadata flag (e.g., `cmd.readOnlyAuthStore === true`), then set env and hand the real argv to the main parse. This requires either a double-parse (cost: full program construction on cold path — the codebase goes to real effort to keep subclis lazy via `register.subclis-core.ts`) or a lightweight hand-written argv walker that understands Commander's option grammar (cost: maintenance burden, must mirror Commander's behavior).

**Trade-off:** True structural resolution that handles aliases and options between tokens — but breaks the lazy-subcli cold-path design and introduces a parse-twice failure mode around help/error output.

### Approach C — Lazy-read consumers plus preAction hook

Consumers already read env at call-time (confirmed in Q2), so no consumer changes needed. Attach `.command("audit")` with a custom property `(cmd as Command & { __forceReadOnlyAuthStore?: true }).__forceReadOnlyAuthStore = true` at `src/cli/secrets-cli.ts:84`, and extend `registerPreActionHooks` in `src/cli/program/preaction.ts` to walk from `actionCommand` and set the env if the flag is present anywhere on the path. Remove the entry.ts argv-sniff entirely.

**Trade-off:** Cleanest coupling (env gate lives next to the command that needs it, zero entry.ts knowledge) but loses pre-import safety net — any future module-load-time env capture becomes a latent bug, and the change surface is larger (entry.ts + preaction.ts + secrets-cli.ts + new tests) than A.

## Recommendation

Go with **A**. It's the smallest change (two files: `secrets-cli.ts` adds the manifest + a test; `entry.ts` imports the manifest), preserves pre-import env timing as defense-in-depth, keeps the cold path untouched, and converts silent security regression into a test failure. Keep C in mind as a follow-up if the repo adopts a broader "command metadata" pattern.

## Sources

- `src/entry.ts:22-30, 60-62` — current argv-sniff
- `src/cli/secrets-cli.ts:46-54, 84-93` — parent `secrets` and child `audit` Commander registration
- `src/cli/program/build-program.ts:1-29` — Commander program construction, preaction wiring
- `src/cli/program/preaction.ts:1-50` — existing preAction hook pattern, command-path walking
- `src/cli/program/register.subclis-core.ts:206-210` — lazy subcli registration for secrets
- `src/cli/program/subcli-descriptors.ts:142-145` — parallel descriptor catalog pattern
- `src/agents/auth-profiles/store.ts:230` — call-time env read
- `src/agents/pi-model-discovery.ts:155-158` — call-time env read

**Confidence breakdown:**

- Q1 (registration): HIGH — direct file read, verified framework
- Q2 (ordering): HIGH — grep confirmed only one env reference per consumer, both inside function bodies
- Q3 (hooks): HIGH — existing preaction.ts confirms Commander hook usage
- Q4 (existing pattern): HIGH — exhaustive grep over `src/cli/program/**` found no precedent
- Q5 (approaches): HIGH for A and C; MEDIUM for B (double-parse cost estimated, not measured)
