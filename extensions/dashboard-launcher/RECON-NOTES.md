# RECON-NOTES — `dashboard-launcher` extension

> Phase C planning artefact. Confirms / corrects assumptions in
> `(MissionControl) docs/plans/2026-04-25-004-feat-openclaw-dashboard-extension-plan.md`
> before Units 2–5 land. Delete or archive once that PR ships.

## Plugin SDK landing pad — confirmed

| Concern                                | Reality                                                                                                                                                                                                                                                         | Source                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level CLI verb registration        | `api.registerCli((ctx) => …, { commands: ["dashboard"] })` from inside `register(api)`. The registrar receives `{ program }` (Commander.js) and adds subcommands directly.                                                                                      | `src/plugins/types.ts:2084`, examples in `extensions/browser/plugin-registration.ts:35`, `extensions/memory-core/index.ts:61`, `extensions/voice-call/index.ts:597`, `extensions/qa-lab/index.ts:9` |
| Plugin entry shape                     | `definePluginEntry({ id, name, description, register })` from `openclaw/plugin-sdk/plugin-entry`. Entry file is `index.ts` at the package root.                                                                                                                 | `src/plugin-sdk/plugin-entry.ts`, `extensions/diagnostics-otel/index.ts`                                                                                                                            |
| Manifest                               | `openclaw.plugin.json` (id + configSchema) **plus** `package.json` `openclaw` block (extensions, runtimeExtensions, compat.pluginApi, build.openclawVersion).                                                                                                   | `extensions/diagnostics-otel/{openclaw.plugin.json,package.json}`                                                                                                                                   |
| `nodeHostCommands` ≠ CLI verbs         | `nodeHostCommands` are gateway-routed JSON-RPC commands (`{ command, cap, handle(paramsJSON) }`). Wrong tool for `openclaw dashboard start`. Use `registerCli` instead.                                                                                         | `src/plugins/types.ts:1931`, `extensions/browser/plugin-registration.ts`                                                                                                                            |
| `registerService` for long-lived loops | `OpenClawPluginService` has `start(ctx)` / `stop(ctx)`. **NOT** the right model for the supervisor — the supervisor only runs while the user is shell-blocked on `openclaw dashboard start`, not as a gateway-resident service. Stay inline in the CLI handler. | `src/plugins/types.ts:1976`                                                                                                                                                                         |

**Implication:** Plan 004 Unit 5's "modify `src/cli/command-catalog.ts`" assumption was overly cautious. We need to add a `commandPath: ["dashboard"]` entry to that catalog **only** for policy hints (`loadPlugins: "always"` so the extension is loaded when the verb is invoked). Command _behaviour_ lives entirely inside the extension.

## CODEOWNERS — `src/cli/command-catalog.ts`

`grep -E '^/src/cli' .github/CODEOWNERS` — no rule. The file falls through to the default owners (no explicit reviewer pinned). The secops block (`@openclaw/secops`) covers `*auth*`, `*secret*`, security paths — adding a non-security `commandPath: ["dashboard"]` row should not trigger it.

**Caveat:** the openclaw `AGENTS.md` says "Larger behavior/product/security/ownership: owner ask/review." A new top-level CLI verb is a public surface, so even without a CODEOWNERS rule, the maintainer should be looped in via PR review before this lands. **No emergency bypass.**

## `openclaw status` row contribution — research deferred

`grep -rn "openclaw status\|registerStatus" src/gateway src/cli` did not turn up an obvious `api.registerStatus(...)` API. R8 ("`openclaw status` gains a `dashboard:` row") is therefore **deferred to a follow-up plan** rather than scoped into this extension. The standalone `openclaw dashboard status` verb (Unit 4) is sufficient for v1.

## Existing extensions to mirror

- **Closest analog**: `extensions/qa-lab/` (small extension that registers a CLI command via `api.registerCli`, no provider/channel surface). Mirror its `package.json`, `index.ts`, `openclaw.plugin.json` shape.
- **CLI registration shape**: `extensions/browser/plugin-registration.ts:35` — `api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] })`.

## Process supervision precedent

`grep -l "child_process" extensions/*/` shows a few extensions spawn child processes (codex, discord, feishu, google-meet, bluebubbles), but none run a long-lived restart-on-crash supervisor in the foreground of a CLI invocation. Plan 004's `supervisor.ts` is novel — no in-tree pattern to mirror.

**Implication:** the supervisor needs its own focused tests (covered by the plan's test scenarios in Unit 3). Existing extensions don't tell us anything about behaviour-under-launchd-supervision; Mission Control's launchd plist is the only such precedent and that lives in the operator's `~/Library/LaunchAgents/`, not in either repo.

## Documentation surface checklist

Per the openclaw repo `AGENTS.md` "New channel/plugin/app/doc surface: update `.github/labeler.yml` + GH labels":

- [ ] Add `dashboard-launcher: extensions/dashboard-launcher/**` to `.github/labeler.yml`
- [ ] Create the matching GH label (`area:dashboard-launcher` or whatever convention the repo uses — verify against existing labels before opening the PR)
- [ ] If `extensions/AGENTS.md` lists known extensions, add a one-liner there too
- [ ] If a new `AGENTS.md` is added inside the extension, also add a sibling `CLAUDE.md` symlink (per repo convention)

## Repo gates the PR will face

| Gate                                                         | Why this PR triggers it                                  |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm check:changed` (extension prod lane)                   | New extension prod code                                  |
| `pnpm test:changed` (extension test lane)                    | New `extensions/dashboard-launcher/test/*.test.ts` files |
| `pnpm tsgo` (typecheck via tsgo only — never `tsc --noEmit`) | TS code                                                  |
| `pnpm build`                                                 | New extension shipped as part of the bundle              |
| `pnpm check:architecture`                                    | New extension boundary-checks                            |

## Open questions for the maintainer review

1. Should the new top-level verb be `openclaw dashboard` or namespaced under an existing parent verb? (Plan picks `openclaw dashboard`; verify against repo's CLI taxonomy before merge.)
2. Acceptable to defer R8 (status-row contribution) to a follow-up plan once the `registerStatus` SDK seam is confirmed?
3. The plan's `--adopt` flag uses `lsof` — acceptable, or should it be implemented in pure Node? (No precedent in the repo either way.)

## Verdict

Plan 004 is implementable as written, with two adjustments:

1. **Don't touch `src/cli/command-catalog.ts` first.** Try `api.registerCli` only and rely on the SDK's lazy-load path. Add a catalog row only if discovery / banner / load-policy regression appears.
2. **Defer R8** (`openclaw status` row) to a follow-up. Keep this extension scoped to its own `dashboard` verb.

With those, Units 2–5 can proceed without architectural surprises. Estimated landing footprint: 1 new extension (~10 files), 0 changes to `src/cli/`, 1 small change to `.github/labeler.yml`.
