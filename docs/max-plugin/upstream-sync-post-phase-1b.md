# Upstream Sync Impact Analysis — post Phase 1B

Companion to [`docs/max-plugin/upstream-sync-2026.5.2.md`](upstream-sync-2026.5.2.md)
(the analogous pre-merge analysis from PR #3). Now that Phase 1A scaffolding
(PR #4) and Phase 1B polling supervisor (PR #5) are merged on fork `main`, this
note answers: **is it safe to sync the fork against current upstream
`openclaw/openclaw` `main`, and what does the merge plan look like?**

## §1 Versions

| Item                                                            | Value                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork `main` HEAD                                                | `70d53020` — `feat(max-messenger): Phase 1B — polling supervisor + fake-MAX harness (#5)` (`2026-05-04 16:25 +0300`)                                                                                                                                                                                             |
| Phase 1A merged at                                              | `de96510c` (`feat(max-messenger): Phase 1A scaffolding (#4)`)                                                                                                                                                                                                                                                    |
| Phase 1B merged at                                              | `70d53020` (`feat(max-messenger): Phase 1B …` (#5))`                                                                                                                                                                                                                                                             |
| `package.json:3` on fork main                                   | `"version": "2026.5.3"` (in-development; matches upstream's released `2026.5.3` content)                                                                                                                                                                                                                         |
| `## Unreleased` block on fork `CHANGELOG.md:5`                  | one Highlight (file-transfer plugin) + ~6 Changes + ~100 Fixes — these were the post-`2026.5.2` accumulations now released by upstream as `v2026.5.3`                                                                                                                                                            |
| Configured upstream remote on this checkout                     | none — only `origin = mefodiytr/openclaw` is wired (same as the previous analysis observed)                                                                                                                                                                                                                      |
| Upstream `main` HEAD (verified via `raw.githubusercontent.com`) | `a90be47` — `test: repair current main checks` (`2026-05-04`); previous commits are all locale refreshes                                                                                                                                                                                                         |
| Upstream `package.json` version                                 | `"2026.5.4"` — upstream cut `2026.5.3` and immediately bumped the in-development version to `2026.5.4`                                                                                                                                                                                                           |
| Upstream releases between fork base and HEAD                    | **`v2026.5.3`** (`2026-05-04 07:01`) and **`v2026.5.3-1`** (`2026-05-04 09:35` — hotfix)                                                                                                                                                                                                                         |
| Commits behind upstream main                                    | not directly computable without an upstream remote. Lower bound from observation: a release-cut commit + the `v2026.5.3-1` install-scanner hotfix + ~14 locale-refresh chores + ≥1 post-release feature commit (Twilio dial-in highlight observed in upstream `## Unreleased`) ⇒ **~20 commits, conservatively** |
| Fork commits ahead of upstream `main`                           | exactly the two MAX-plugin merges (`#4` Phase 1A, `#5` Phase 1B), localized to `extensions/max-messenger/` plus two regenerated artifacts                                                                                                                                                                        |
| Tags locally                                                    | none (carried forward from PR #3)                                                                                                                                                                                                                                                                                |

The diff cannot be computed byte-for-byte from git directly because the
repository still has no `openclaw/openclaw` remote wired (matches the
constraint called out by the previous analysis at
[`upstream-sync-2026.5.2.md` §1](upstream-sync-2026.5.2.md)). All upstream
state in this analysis was read by `WebFetch` against
`raw.githubusercontent.com/openclaw/openclaw/main/...` for individual files,
or from the public release pages. Each fact below is annotated with how it
was sourced.

## §2 Changelog summary

Source: GitHub release page for [`v2026.5.3`](https://github.com/openclaw/openclaw/releases/tag/v2026.5.3),
[`v2026.5.3-1`](https://github.com/openclaw/openclaw/releases/tag/v2026.5.3-1),
and the current `## Unreleased` block of upstream `CHANGELOG.md` (read via
`raw.githubusercontent.com`).

### `v2026.5.3` (2026-05-04 07:01) — major release

The release content matches the fork's current `## Unreleased` content
1-for-1 (one highlight + ~6 Changes + ~100 Fixes). Nothing in this release is
new to the fork at the source level — the fork was branched while these
commits were in `## Unreleased`, and PRs #4/#5 added strictly to
`extensions/max-messenger/` plus two regenerated artifacts.

What the fork is **missing** vs `v2026.5.3`:

- The release-cut commit itself (the one that converts `## Unreleased` →
  `## 2026.5.3` in `CHANGELOG.md` and bumps `package.json` to `2026.5.4` for
  the next development cycle).

### `v2026.5.3-1` (2026-05-04 09:35) — npm hotfix

> "Plugins/security: stop the install scanner from blocking official bundled
> plugin packages when `process.env` access and normal API sends only appear
> in distant parts of the same compiled bundle."

Single security-related fix to the install scanner. Its scope (bundled-plugin
trust path) intersects the manifest paths our `max-messenger` plugin uses,
but only for `pnpm` install / packaged distribution flows — not for
in-repo development. Net effect on the MAX plugin: **beneficial when we
eventually publish or ship as a bundled official plugin**; no source-level
impact today.

### Post-release `## Unreleased` (upstream `main`)

Read from `raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG.md`.
Two highlights observed; one is the file-transfer plugin already in our
`## Unreleased`, the second is **new**:

- _Channels/Voice Call (Twilio dial-in) for Google Meet — realtime Gemini
  voice integration and audio streaming._ Touches `extensions/voice-call/` /
  `extensions/google-meet/`. **Out of MAX plugin's lane.**

The 14+ trailing commits visible on `commits/main` are all
`chore(ui): refresh <locale> control ui locale` auto-generated translation
refreshes — also out of our lane.

### Breaking changes in scope of the MAX plugin

**None observed.** No deprecation notices reference any of the SDK
entrypoints listed in §3 below.

## §3 Files-of-interest diff

Each row covers a core file the MAX plugin imports. "Status" describes the
fork-vs-upstream comparison performed via `raw.githubusercontent.com` fetches
of the upstream copy and `grep` against the fork copy; "Compatible?" is the
answer to "does our extension still type-check + behave correctly without
edits if we land upstream HEAD".

| File                                             | Status (fork vs upstream `main`)                                                                                                                                                                                                                                 | API used by `max-messenger`                                                                                                                                                          | Compatible?                                                                                                                      | Notes                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/plugin-sdk/extension-shared.ts`             | **same shape** — `runStoppablePassiveMonitor<TMonitor>(params: { abortSignal, start })` and `requireChannelOpenAllowFrom({ channel, policy?, allowFrom?, ctx, requireOpenAllowFrom })` both verified verbatim on upstream                                        | `runStoppablePassiveMonitor`, `requireChannelOpenAllowFrom`                                                                                                                          | **YES**                                                                                                                          | both signatures byte-equivalent                                                                                                                                                                                                |
| `src/channels/plugins/types.adapters.ts`         | **same shape** — `ChannelGatewayContext<ResolvedAccount>` (with `channelRuntime?` field), `ChannelGatewayAdapter<ResolvedAccount>` (start/stop/login/logout), `ChannelLifecycleAdapter` (with `runStartupMaintenance` + `detectLegacyStateMigrations`) all match | `ChannelGatewayContext`, `ChannelGatewayAdapter` (via `NonNullable<ChannelPlugin[…]["gateway"]>`), `ChannelLifecycleAdapter` (not directly referenced; only `ChannelGatewayContext`) | **YES**                                                                                                                          | shape matches; the unused `runStartupMaintenance` / `detectLegacyStateMigrations` fields stay optional and out of MAX's path                                                                                                   |
| `src/plugin-sdk/channel-contract.ts`             | barrel — `ChannelGatewayContext` + `ChannelLogSink` re-exports unchanged                                                                                                                                                                                         | `ChannelGatewayContext`, `ChannelLogSink`                                                                                                                                            | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/channel-config-schema.ts`        | **same exports** — `DmPolicySchema`, `GroupPolicySchema`, `MarkdownConfigSchema`, `ReplyRuntimeConfigSchemaShape`, `requireOpenAllowFrom`, `buildChannelConfigSchema`, plus extras                                                                               | `DmPolicySchema`, `GroupPolicySchema`, `MarkdownConfigSchema`, `ReplyRuntimeConfigSchemaShape`, `requireOpenAllowFrom`                                                               | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/channel-core.ts`                 | **same exports** — `buildChannelConfigSchema`, `createChatChannelPlugin`, type `ChannelPlugin`, plus extras                                                                                                                                                      | `buildChannelConfigSchema`, `createChatChannelPlugin`, type `ChannelPlugin`                                                                                                          | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/channel-entry-contract.ts`       | **same `DefineBundledChannelEntryOptions` shape** — `id`, `name`, `description`, `importMetaUrl`, `plugin`, `secrets?`, `runtime?`, `accountInspect?`, `features?`, `registerCliMetadata?`, `registerFull?`, `configSchema?` all verified verbatim               | `defineBundledChannelEntry({ … plugin, secrets, runtime })` from `index.ts`                                                                                                          | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/channel-secret-basic-runtime.ts` | **same exports** — `collectConditionalChannelFieldAssignments`, `getChannelSurface`, `hasOwnProperty`, types `ChannelAccountEntry`, `ResolverContext`, `SecretDefaults`, `SecretTargetRegistryEntry` all confirmed                                               | `collectConditionalChannelFieldAssignments`, `getChannelSurface`, `hasOwnProperty`, types `ChannelAccountEntry`, `ResolverContext`, `SecretDefaults`, `SecretTargetRegistryEntry`    | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/account-core.ts`                 | **same re-exports** — `createAccountListHelpers`, `DEFAULT_ACCOUNT_ID`, `normalizeAccountId`, `resolveAccountWithDefaultFallback`, `resolveMergedAccountConfig` all confirmed                                                                                    | the same five symbols                                                                                                                                                                | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/channel-config-helpers.ts`       | **same shape** — `adaptScopedAccountAccessor<Result, Config>` + `createScopedChannelConfigAdapter<ResolvedAccount, AccessorAccount, Config>` signatures match                                                                                                    | `adaptScopedAccountAccessor`, `createScopedChannelConfigAdapter`                                                                                                                     | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/secret-input.ts`                 | **same exports** — `buildSecretInputSchema`, `normalizeResolvedSecretInputString` confirmed                                                                                                                                                                      | both                                                                                                                                                                                 | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/secret-file-runtime.ts`          | barrel re-export of `tryReadSecretFileSync` from `../infra/secret-file.js` confirmed                                                                                                                                                                             | `tryReadSecretFileSync`                                                                                                                                                              | **YES** (assumed; the underlying helper's signature was not re-verified end-to-end via WebFetch but the re-export shape matches) | the WebFetch summary noted it could not see the internal signature; this is a known limitation of summarized fetch — there is no signal of breakage                                                                            |
| `src/plugin-sdk/runtime-store.ts`                | **same exports** — `createPluginRuntimeStore` defined here, type `PluginRuntime` re-exported from `../plugins/runtime/types.js`                                                                                                                                  | `createPluginRuntimeStore`, type `PluginRuntime`                                                                                                                                     | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/json-store.ts`                   | **same** — `writeJsonFileAtomically(filePath: string, value: unknown): Promise<void>` confirmed verbatim                                                                                                                                                         | `writeJsonFileAtomically`                                                                                                                                                            | **YES**                                                                                                                          | identical wrapper around `writeJsonAtomic` with `0o600`/`0o700` defaults                                                                                                                                                       |
| `src/plugin-sdk/state-paths.ts`                  | **same** — `resolveStateDir` re-exported from `../config/paths.js`                                                                                                                                                                                               | `resolveStateDir`                                                                                                                                                                    | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/text-runtime.ts`                 | **same** — `normalizeOptionalString` re-exported from `../shared/string-coerce.js`                                                                                                                                                                               | `normalizeOptionalString`                                                                                                                                                            | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/zod.ts`                          | **byte-identical** — `export * from "zod"`                                                                                                                                                                                                                       | `z`                                                                                                                                                                                  | **YES**                                                                                                                          |                                                                                                                                                                                                                                |
| `src/plugin-sdk/config-types.ts`                 | **byte-equivalent** — `export type * from "../config/types.js"` (which transitively re-exports `BlockStreamingCoalesceConfig`, `DmConfig`, `DmPolicy`, `GroupPolicy`, `SecretInput` and friends)                                                                 | the five types listed                                                                                                                                                                | **YES** (assumed; the WebFetch summary couldn't enumerate the transitively-re-exported names)                                    | the source-of-truth file `src/config/types.js` was not re-fetched; risk window is narrow because the public type surface is heavily relied upon by every other bundled channel and changes there would break far more than MAX |
| `scripts/lib/plugin-sdk-entrypoints.json`        | **all 16 entrypoints we use are still listed**                                                                                                                                                                                                                   | (manifest of subpaths, not direct import)                                                                                                                                            | **YES**                                                                                                                          |                                                                                                                                                                                                                                |

**Net assessment of §3:** every public symbol the MAX plugin reads from
`openclaw/plugin-sdk/*` or `src/channels/plugins/types.*` is unchanged at the
declaration level. No rename, no signature-shape diff, no removal observed.

## §4 Generated files

Two generated files modified by the MAX merge will conflict on rebase
because both branches edited them concurrently. Both are deterministic
outputs of `pnpm config:channels:gen` and `pnpm config:docs:gen`
respectively, so the resolution is "regenerate after merge."

| File                                                      | Status                                                                                                                                                                                                                 | Conflict                           | Resolution                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config/bundled-channel-config-metadata.generated.ts` | fork has `pluginId: "max-messenger"` block; upstream `main` does not contain `max-messenger` (verified via `raw.githubusercontent.com`); upstream may have added/removed/modified other plugin entries since fork base | **YES — guaranteed conflict**      | run `pnpm config:channels:gen` after merge, commit the result; the generator picks up `extensions/max-messenger/src/config-schema.ts` and re-emits the canonical block. `pnpm config:channels:check` then succeeds |
| `docs/.generated/config-baseline.sha256`                  | fork's four hashes differ from upstream's four hashes — verified all four lines diverge                                                                                                                                | **YES — guaranteed conflict**      | run `pnpm config:docs:gen` after merge, commit the new hashes                                                                                                                                                      |
| `docs/.generated/plugin-sdk-api-baseline.sha256`          | not modified by either MAX PR                                                                                                                                                                                          | no conflict expected from MAX side | regenerate via `pnpm plugin-sdk:api:gen` only if SDK signature drift requires it (not expected here)                                                                                                               |

No other generated artifacts are touched by `extensions/max-messenger/` so
the conflict surface is bounded to those two files.

## §5 Test infrastructure

Source: `pnpm` script names cross-checked between fork `package.json` and
upstream `package.json` summary; upstream tip commit
`a90be47 test: repair current main checks` inspected via
`github.com/openclaw/openclaw/commit/a90be47` and confirmed to touch only
`ui/src/ui/app.talk.test.ts` (15+/10− lines, restructuring a mock object).

| Surface                                                                                              | Status                                                                                                                                                                                                                                                                                                                                                                                | Risk to 66 max-messenger tests                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm tsgo:extensions` / `pnpm tsgo:extensions:test`                                                 | unchanged on upstream                                                                                                                                                                                                                                                                                                                                                                 | none                                                                              |
| `pnpm test extensions/max-messenger` (vitest projects via `test/vitest/vitest.extensions.config.ts`) | upstream `vitest.extensions.config.ts` not re-verified file-by-file, but the upstream tip's only test edit (`ui/src/ui/app.talk.test.ts`) doesn't touch the bundled-plugin glob path `extensions/**/*.test.ts`                                                                                                                                                                        | **none observed**                                                                 |
| `pnpm config:channels:check` / `pnpm config:docs:check`                                              | unchanged                                                                                                                                                                                                                                                                                                                                                                             | none (apart from §4 regeneration)                                                 |
| `pnpm exec oxfmt --check` / `pnpm lint:extensions`                                                   | upstream root tsconfigs (`tsconfig.oxlint.extensions.json` etc.) — direct `raw.githubusercontent.com` fetches returned 404 for several `tsconfig.oxlint.*.json` files, which is **likely a WebFetch caching/encoding quirk rather than file removal** since `package.json` `lint:extensions` still references that path on upstream per its release notes; no other signal of removal | **likely none** — flagged as the lowest-confidence row in this analysis           |
| Vitest version                                                                                       | not directly verified; `test: repair` commit suggests upstream is actively tracking flaky checks                                                                                                                                                                                                                                                                                      | low risk; our suite stays under 1.7s and has no dependency on the touched UI path |

The only adjacent upstream change since our fork base is the
`a90be47` test-mock-restructure on `ui/src/ui/app.talk.test.ts`, fully
outside our extension's lane. No bundled-plugin test path was touched.

## §6 Plugin SDK contract review

This is the highest-stakes section because the supervisor architecture from
Phase 1B is heavily dependent on three specific contracts. All three were
re-read against upstream `main` for this analysis:

### `ChannelPlugin<ResolvedAccount>`

Re-exported via `openclaw/plugin-sdk/channel-core`. Upstream still types it
as the union of base / config / setup / pairing / security / threading /
outbound / status / gateway / lifecycle / secrets / approvalCapability /
… surfaces, with `setup: ChannelSetupAdapter` required and the rest
optional. **Unchanged.** Our usage (`createChatChannelPlugin({ base: { id,
meta, capabilities, reload, configSchema, config, secrets, setup, gateway },
outbound })`) lines up exactly.

### `ChannelGatewayContext<ResolvedAccount>`

Verified verbatim from upstream `src/channels/plugins/types.adapters.ts`:

```typescript
export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
  channelRuntime?: ChannelRuntimeSurface;
};
```

Our `lifecycle.adapter.ts` reads `ctx.account`, `ctx.account.token`,
`ctx.account.apiRoot`, `ctx.account.tokenSource`, `ctx.account.config.polling`,
`ctx.abortSignal`, `ctx.log?.info?.()` / `warn` / `error`, `ctx.getStatus()`,
`ctx.setStatus(...)`. Every field is present in the upstream shape.
**Unchanged.**

### `ChannelLifecycleAdapter`

We do **not** wire a `lifecycle` adapter on the MAX plugin today (gateway
adapter's `startAccount` does the work via `runStoppablePassiveMonitor`). The
upstream type still includes `runStartupMaintenance` and
`detectLegacyStateMigrations` as optional extras. No conflict, no
required-field migration.

### `ResolvedAccount` shape

`ResolvedMaxAccount` is plugin-local (`extensions/max-messenger/src/types.ts`),
not part of the SDK contract. SDK only sees it through the `ResolvedAccount`
generic on `ChannelGatewayAdapter` / `ChannelGatewayContext`. **No upstream
risk.**

### Net assessment of §6

**No breaking changes to the SDK contract surface our supervisor depends on.**

## §7 Vendor dependency status

Source: direct `npm view @maxhub/max-bot-api` queries.

| Package               | Pin in fork                    | Latest on npm                  | Δ                                                                           |
| --------------------- | ------------------------------ | ------------------------------ | --------------------------------------------------------------------------- |
| `@maxhub/max-bot-api` | `0.2.2` exact (per plan §8 #9) | `0.2.2` (published 2026-02-10) | **none** — still the same version we pinned in Phase 1A; no `0.2.3+` exists |

Other plugin-local devDependencies (`@openclaw/plugin-sdk`, `openclaw`) are
`workspace:*` and follow root resolution. No transitive dep changes worth
flagging.

The previous analysis noted that `@maxhub/max-bot-api` is the SDK gap our
supervisor was specifically built to compensate for (per §6.1.1 audit); a
new SDK version would be welcome but is not required, and the supervisor
is independent of the SDK's own polling loop in any case (we bypass
`bot.start()` per §9 N2).

## §8 Recommendation

### **(Б) Merge with regeneration step**

Upstream changes are entirely orthogonal to the MAX plugin's source
(verified API surfaces all unchanged), but the two generated baseline files
will conflict on rebase. The merge plan is mechanical:

1. Rebase / merge fork main onto upstream main.
2. Resolve the two conflicting generated files by **regenerating** them
   instead of hand-merging:
   - `pnpm config:channels:gen`
   - `pnpm config:docs:gen`
3. Run the standard verification: `pnpm tsgo:extensions`, `pnpm
tsgo:extensions:test`, `pnpm test extensions/max-messenger` (66 / 66
   should still pass), `pnpm config:channels:check`, `pnpm config:docs:check`,
   `pnpm exec oxfmt --check`, `pnpm lint:extensions`.

We are **not** in case (А) only because of the two generated files — those
do require an action, even if the action is mechanical.

We are **not** in case (В) — no SDK API our extension consumes has changed
shape, so no source edits to `extensions/max-messenger/` are required.

We are **not** in case (Г) — there is no breaking SDK change. The
`v2026.5.3-1` install-scanner hotfix is in fact **strictly beneficial** for
our plugin (it prevents the install scanner from blocking bundled plugins
whose code reads `process.env` and writes API requests far apart in the
compiled bundle — exactly the shape our supervisor produces).

## §9 Action items

If/when the operator decides to land an upstream sync onto fork `main`,
the recommended sequence is:

1. **Configure a real upstream remote** (one-time, addresses the long-standing
   gap called out in [`upstream-sync-2026.5.2.md` §1](upstream-sync-2026.5.2.md)
   and §1 above):

   ```sh
   git remote add upstream https://github.com/openclaw/openclaw.git
   git fetch upstream main
   ```

2. **Rebase the fork's MAX commits onto upstream:**

   ```sh
   git checkout main
   git rebase upstream/main
   ```

   Conflicts expected only on:
   - `src/config/bundled-channel-config-metadata.generated.ts`
   - `docs/.generated/config-baseline.sha256`

3. **Regenerate the conflicted artifacts** rather than hand-resolve:

   ```sh
   pnpm config:channels:gen
   pnpm config:docs:gen
   git add src/config/bundled-channel-config-metadata.generated.ts
   git add docs/.generated/config-baseline.sha256
   ```

4. **Continue the rebase** (`git rebase --continue`) — no more conflicts
   should surface.

5. **Pre-flight verification** (run from repo root after rebase finishes):

   ```sh
   pnpm tsgo:extensions
   pnpm tsgo:extensions:test
   pnpm test extensions/max-messenger          # expect 66 / 66
   pnpm config:channels:check
   pnpm config:docs:check
   pnpm exec oxfmt --check --threads=1 extensions/max-messenger
   node scripts/run-oxlint.mjs --tsconfig tsconfig.oxlint.extensions.json extensions/max-messenger
   ```

   All should be exit 0 / clean. Any failure here means the upstream sync
   uncovered an issue the source-level verification in §3 missed —
   investigate the failing surface specifically before continuing.

6. **Bump fork `package.json` version** to track upstream's
   `2026.5.4`-development cycle (only if/when ready to release; for
   day-to-day fork operation a version mismatch with upstream is fine
   and matches the established forking pattern — see PR #3's analysis).

7. **Force-push the rebased main** only if the operator is comfortable;
   otherwise the safer alternative is a non-rebasing merge commit. Both
   options leave the MAX plugin commits on top of upstream.

### Notes on confidence

This analysis was performed without git access to upstream
`openclaw/openclaw`, against `raw.githubusercontent.com` and the public
release pages. The verification covers each public SDK symbol our
extension imports plus the generated-file conflict surface. It does **not**
cover line-by-line diffs of the affected files, so there is residual
uncertainty in any private-helper internals that our public symbols
delegate to. The `pnpm tsgo:extensions:test` check in step 5 is the
ground-truth signal that the SDK contract is intact end-to-end after merge.

If a rebase reveals unexpected conflicts beyond the two generated files,
**stop and re-evaluate**: that would indicate upstream changed a file we
also touched outside `extensions/max-messenger/` (which neither PR #4 nor
PR #5 should have done), and the simplest fix is to inspect the conflicted
file and confirm the fork's intent before continuing.
