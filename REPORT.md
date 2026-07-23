# W4 Drafts UX implementation report

## Outcome

Implemented the complete drafts UX on top of the landed ownership, visibility, membership, and person-filter machinery.

- New-session creation can start atomically as `visibility: "draft"`; the initial durable session entry carries draft visibility before the create response or any session-change broadcast.
- The create affordance is exposed only when the hello policy allows drafts and the Gateway reports at least two canonical, non-merged sharing identities. Older gateways and solo mode fail closed by hiding the control.
- Own drafts keep normal row emphasis with a subtle ghost marker. Admin-visible drafts owned by someone else use the same draft class family with a faded, light/dark-safe treatment.
- A dedicated **Publish draft** header menu item calls the existing visibility callback with `"shared"`, which continues through the landed `session.visibility.set` RPC, audit-line, rollback, and live-event path.
- Multi-user and sharing configuration docs now explain create-as-draft behavior, admin visibility, and the non-security-boundary constraint.
- No suggestion queue, invite link, config key, SQLite schema/table/version, membership enforcement, new Gateway event, or changelog change was added.

## Files changed

### Protocol and Gateway

- `packages/gateway-protocol/src/schema/sessions-create.ts`
- `packages/gateway-protocol/src/schema/sessions-create.test.ts`
- `packages/gateway-protocol/src/schema/frames.ts`
- `src/gateway/session-create-service.ts`
- `src/gateway/server-methods/sessions-create.ts`
- `src/gateway/server/ws-connection/connect-hello.ts`
- `src/gateway/server.sessions.create.test.ts`
- `src/gateway/server.auth.default-token.suite.ts`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`

The Kotlin generators ran successfully; their tracked outputs were byte-identical. `dist/protocol.schema.json` is generated locally by protocol checks but remains ignored and untracked, matching `origin/main`.

### Control UI

- `ui/src/pages/new-session/new-session-page.ts`
- `ui/src/pages/new-session/create-params.ts`
- `ui/src/pages/new-session/create-params.test.ts`
- `ui/src/pages/new-session/catalog-target.ts`
- `ui/src/pages/new-session/target-controls.ts`
- `ui/src/pages/new-session/target-controls.test.ts`
- `ui/src/pages/chat/components/chat-session-sharing.ts`
- `ui/src/pages/chat/components/chat-session-sharing.test.ts`
- `ui/src/components/app-sidebar-session-navigation-logic.ts`
- `ui/src/components/app-sidebar-session-navigation-logic.test.ts`
- `ui/src/components/app-sidebar-session-row-render.ts`
- `ui/src/components/app-sidebar-session-types.ts`
- `ui/src/styles/components.css`
- `ui/src/styles/new-session.css`
- `ui/src/i18n/locales/en.ts`
- `ui/src/e2e/session-ownership.e2e.test.ts`
- `ui/src/test-helpers/control-ui-e2e.ts`

### Docs

- `docs/concepts/multi-user.md`
- `docs/gateway/config-agents.md`

### Local proof artifacts, not committed

- `.artifacts/control-ui-e2e/drafts-ux/behavior-contract.md`
- `.artifacts/control-ui-e2e/drafts-ux/01-sidebar-draft-treatment.png`
- `.artifacts/control-ui-e2e/drafts-ux/01-sidebar-draft-treatment-dark.png`
- `.artifacts/control-ui-e2e/drafts-ux/02-create-draft-available.png`
- `.artifacts/control-ui-e2e/drafts-ux/03-create-draft-selected.png`
- `.artifacts/control-ui-e2e/drafts-ux/04-publish-draft-action.png`
- `.artifacts/control-ui-e2e/drafts-ux/*.webm`

## Key decisions and ambiguity resolution

1. `visibility` is optional and additive in `SessionsCreateParamsSchema`. The service rejects a disallowed visibility with the existing `SESSION_VISIBILITY_DISABLED` error shape and rejects create-time visibility when an existing keyed session would be adopted or reset in place.
2. The hello `policy` object now exposes optional `allowedSessionVisibilities` and `hasMultipleSessionSharingIdentities`. Current Gateways always populate both. Optional schema fields preserve compatibility with older Gateway/client pairs.
3. The multi-user boolean comes from canonical non-merged user profiles, not loaded session creators. It reveals only whether the draft UI's two-identity threshold is met, not the exact profile count.
4. The new-session UI rechecks the hello policy at submit time. A stale checked control cannot submit draft visibility after policy/identity availability disappears.
5. Admin ownership styling compares the session creator id with the current authenticated user id because `sharingRole: "admin"` intentionally wins over `"owner"` for administrators.
6. Promotion remains one existing `session.visibility.set` call with `visibility: "shared"`; no parallel publish method, event, audit path, or invite workflow was introduced.
7. The sidebar's pending unsent-composer `showDraft`/`renderDraftSessionRow` machinery was not touched.

## Verification

All final commands below ran against feature HEAD `5f4e34fe9ef4859a4d0064802e67c22c30ffe42f`, based on `34caf4b0dc59f8fdada97fd6935d0ca29667f1cf`. `origin/main` advanced again after proof; the reviewer-requested final rebase remains outstanding.

### Install and formatting

- `pnpm install`
  - Initial fresh install: exit 0, 1,272 packages, pnpm 11.2.2.
  - Post-rebase refresh: exit 0; final run reported `Already up to date`.
- `./node_modules/.bin/oxfmt --write --threads=1 <changed files>`
  - Exit 0. The final changed gate reported `All matched files use the correct format.`
- `git diff --check origin/main...HEAD`
  - Exit 0, no output.

### Focused Vitest and browser behavior

- `node scripts/run-vitest.mjs packages/gateway-protocol/src/schema/sessions-create.test.ts ui/src/pages/new-session/create-params.test.ts ui/src/pages/new-session/target-controls.test.ts ui/src/pages/chat/components/chat-session-sharing.test.ts ui/src/components/app-sidebar-session-navigation-logic.test.ts`
  - Exit 0.
  - Gateway-client shard: 1 file, 2 tests passed.
  - UI shard: 4 files, 20 tests passed.
  - Final wrapper: `passed 2 Vitest shards in 21.81s`.
- `node scripts/run-vitest.mjs src/gateway/server.sessions.create.test.ts`
  - Exit 0: 1 file, 61 tests passed; final wrapper `passed 1 Vitest shard in 51.57s`.
- `node scripts/run-vitest.mjs src/gateway/server.auth.default-token.test.ts`
  - Exit 0: 1 file, 23 tests passed; final wrapper `passed 1 Vitest shard in 18.25s`.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/session-ownership.e2e.test.ts`
  - Exit 0: 1 file, 6 tests passed in 8.77s.
  - Proves multi-person availability, solo dormancy, atomic `sessions.create` traffic, own/foreign sidebar treatment, light/dark rendering, and the one-call publish action.
- One combined Gateway run produced 83/84 because the unrelated worktree-provisioning case transiently returned `ok: false` on a loaded host. Its immediate isolated rerun passed 61/61; the final isolated run above also passed 61/61.

### Required typechecks

- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.core.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.ui.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p tsconfig.extensions.json`
  - Exit 0, no diagnostics.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -b tsconfig.projects.json`
  - Exit 0, no diagnostics.

### Protocol and localization

- `pnpm protocol:gen`
  - Exit 0; wrote the local ignored `dist/protocol.schema.json` without adding it to Git.
- `pnpm protocol:gen:swift`
  - Exit 0; wrote `GatewayModels.swift`.
- `pnpm protocol:gen:kotlin`
  - Exit 0; wrote both Kotlin generator targets, with no tracked diff.
- `pnpm protocol:check`
  - Exit 0; regenerated JSON/Swift/Kotlin and printed `protocol since guard passed: 0 new core methods use train 2026.7`.
- `node --import tsx scripts/control-ui-i18n-verify.ts baseline`
  - Exit 0: `raw-copy: baseline entries=105`, `source: keys=3962`.
- `node --import tsx scripts/native-app-i18n.ts baseline --write`
  - Exit 0: `entries=5232 changed=false`.

### Docs and changed gate

- `pnpm docs:check-mdx`
  - Exit 0: `Docs MDX check passed (751 files, 8519ms).`
- `pnpm check:changed`
  - The normal invocation delegated to Testbox `tbx_01ky7qadfw9ew7vz9rwggqpbb2`, which remained queued without an IP for about three minutes. It was explicitly stopped; no remote code command ran.
  - Trusted-source fallback command: `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm check:changed`.
  - Final exit 0.
  - The earlier all-lanes run included the mistakenly tracked `dist/protocol.schema.json`; cleanup verification reruns this gate with the ignored artifact removed from the branch.
  - Final line: `Import cycle check: 0 runtime value cycle(s).`
  - A loaded-host lint run first timed out while generating Plugin SDK root shims at 300 seconds. `OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS=600000 ... prepare-extension-package-boundary-artifacts.mjs` completed the same generator without weakening it; the standard final gate then reported all boundary artifacts `fresh; skipping` and passed lint.

### Autoreview

- Full feature command: `.agents/skills/autoreview/scripts/autoreview --mode uncommitted --stream-engine-output`.
  - Accepted finding: loaded session creators were an invalid proxy for Gateway identities. Fixed with the canonical, privacy-preserving `hasMultipleSessionSharingIdentities` boolean, with handshake and browser coverage.
  - Final source pass: no findings; explanation explicitly confirmed atomic visibility, policy/identity gating, sidebar treatment, and promotion reuse.
  - Cleanup branch review finding: REPORT.md still claimed the ignored schema should be committed. The report was corrected to match `origin/main` tracking policy.
- Final focused correction command used the same helper with an explicit prompt to review only `ui/src/e2e/session-ownership.e2e.test.ts` and treat untracked `SPEC.md` as context.
  - Exit 0: `autoreview clean: no accepted/actionable findings reported`, overall confidence 0.97.

## LOC summary

Implementation diff before adding this report, grouped by role and excluding generated/docs from production:

| Group                  | Added | Deleted |
| ---------------------- | ----: | ------: |
| Production             |   175 |      18 |
| Tests and test support |   423 |       1 |
| Generated Swift        |     4 |       0 |
| Docs                   |     5 |       1 |

The generated total contains only the tracked Swift protocol model. The JSON schema is deliberately excluded because it is ignored and untracked on `origin/main`.

## Commits

- `0e70368a7db feat(protocol): support draft session creation`
- `449563e97f7 feat(ui): add draft session workflows`
- `1d5767244ed docs: explain multi-user drafts`
- `9f6e831c9b8 test(ui): tighten draft ownership fixture`
- `0fed2857071 test(ui): satisfy draft E2E lint`
- `5f4e34fe9ef test(ui): keep draft fixtures strictly typed`

## Skipped or deferred

- No push, pull request, `scripts/pr`, release, publish, `CHANGELOG.md`, or GitHub mutation was performed.
- No SQLite change was needed; therefore there was no schema-version bump or lazy table ensure.
- No new Gateway event was added; existing `sessions.changed` and `session.sharing` paths retain their current scope guards and draft filtering.
- Foreign-language UI bundles were not edited; the requested `en.ts` plus baseline workflow was used.
- Final branch status after proof: feature work is committed and the product tree is clean; only the reviewer-provided, locally formatted `SPEC.md` is untracked. `origin/main` continued advancing after the frozen proof base, so final rebase/landing is intentionally deferred to the reviewer as requested.
