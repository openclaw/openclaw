# W5 archive attribution report

Implementation commit: `083482ea654 feat(sessions): attribute archive transitions`

## Files changed

Session state and mutation:

- `src/config/sessions/session-entry-provenance.ts`
- `src/config/sessions/types.ts`
- `src/gateway/sessions-patch.ts`
- `src/gateway/server-methods/sessions-mutations.ts`
- `src/gateway/server-methods/session-audit.ts`
- `src/gateway/server-methods/sessions-sharing.ts`
- `src/plugins/session-entry-slot-keys.ts`

Gateway projection and event contract:

- `packages/gateway-protocol/src/schema/sessions-row.ts`
- `src/gateway/session-utils.ts`
- `src/gateway/session-utils.types.ts`
- `src/gateway/session-event-payload.ts`
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`

Control UI:

- `ui/src/api/types.ts`
- `ui/src/components/app-sidebar-session-navigation-logic.ts`
- `ui/src/components/app-sidebar-session-row-render.ts`
- `ui/src/components/app-sidebar-session-types.ts`
- `ui/src/components/session-owner-chip.ts`
- `ui/src/i18n/locales/en.ts`
- `ui/src/lib/sessions/reconcile.ts`

Behavior tests:

- `src/gateway/server-methods/sessions-mutations.archive-attribution.test.ts`
- `src/gateway/sessions-patch.test.ts`
- `src/gateway/session-utils-creators.test.ts`
- `src/gateway/session-event-payload.test.ts`
- `packages/gateway-protocol/src/schema/sessions-row.test.ts`
- `ui/src/lib/sessions/reconcile.test.ts`
- `ui/src/test-helpers/app-sidebar-cases/session-ownership.ts`

Task handoff:

- `REPORT.md`

## Key decisions and resolved ambiguities

- `archivedBy` uses the canonical `SessionCreatedActor` shape and is written only on a real unarchived-to-archived transition. Repeating `archived: true` preserves the original archiver. Unarchive clears it.
- The acting identity comes only from `gatewayClientSessionCreator(client)`. Unidentified token/password clients get no fabricated identity and no actor-stamped audit line.
- Archive and unarchive audit notes use the same shared `SessionManager.appendMessage` helper as visibility/membership audit notes. If audit append fails, the complete combined `sessions.patch` entry is restored (or a newly created row is removed) while the session lifecycle lock is still held, so the RPC cannot leave partial metadata changes behind.
- The existing `applySessionPatchProjection` candidate resolver already supplies the freshest authoritative alias entry. Archive transition comparison uses that `existingEntry`, so alias migration does not invent or suppress a transition.
- The session catalog is stored as canonical `session_entries.entry_json`; `archivedBy` is an additive JSON field. No SQL DDL, schema-version bump, backfill, dual path, or migration is needed.
- `sessions.changed` remains the existing event and is still emitted with its concrete session-key scope, so draft/visibility filtering remains in force. No new event or `EVENT_SCOPE_GUARDS` entry was needed.
- In the exact View-archived filter, the existing owner chip renders `archivedBy` with an `Archived by {name}` accessible label. Other session lists retain creator attribution. The existing `sessionOwnershipVisible` gate suppresses this chrome with fewer than two creator identities.
- All protocol generators ran. Swift changed. Kotlin did not change because `scripts/protocol-gen-kotlin.ts` does not include `SessionRow` in its emitted schema whitelist. `dist/protocol.schema.json` was generated and checked, but current main intentionally ignores and does not track `dist/`; force-adding the 1.9 MB ignored artifact would undo repository policy.

## Verification

Dependency install:

```text
pnpm install
Done in 19.9s using pnpm v11.2.2 (exit 0)
```

Focused behavior tests:

```text
node scripts/run-vitest.mjs src/gateway/sessions-patch.test.ts src/gateway/server-methods/sessions-mutations.archive-attribution.test.ts src/gateway/session-utils-creators.test.ts src/gateway/session-event-payload.test.ts packages/gateway-protocol/src/schema/sessions-row.test.ts ui/src/components/app-sidebar.test.ts ui/src/lib/sessions/reconcile.test.ts
Test Files 4 passed, Tests 90 passed (gateway-core)
Test Files 1 passed, Tests 1 passed (gateway-client)
Test Files 2 passed, Tests 175 passed (UI)
[test] passed 3 Vitest shards in 32.67s (exit 0)

node scripts/run-vitest.mjs src/gateway/server-methods/sessions-sharing.test.ts
Test Files 1 passed, Tests 9 passed
[test] passed 1 Vitest shard in 17.36s (exit 0)

node scripts/run-vitest.mjs src/gateway/server-methods/sessions-mutations.archive-attribution.test.ts
Test Files 1 passed, Tests 3 passed (exit 0)
```

The archive-attribution handler tests cover actor stamping, idempotent re-archive, unarchive clearing, exact audit text, unidentified-client behavior, and full rollback of a combined archive plus label patch when audit append fails. The UI suite includes the required collaborative and solo-dormancy archive-row cases.

Protocol and i18n generation/checks:

```text
pnpm protocol:gen && pnpm protocol:gen:swift && pnpm protocol:gen:kotlin
wrote dist/protocol.schema.json
wrote apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift
wrote apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt
wrote apps/android/app/src/main/java/ai/openclaw/app/protocol/OpenClawProtocolConstants.kt
exit 0

pnpm protocol:check
protocol since guard passed: 0 new core methods use train 2026.7
exit 0

node --import tsx scripts/native-app-i18n.ts baseline --write
native-app-i18n: entries=5232 changed=false

node --import tsx scripts/control-ui-i18n-verify.ts baseline
control-ui-i18n: raw-copy: baseline entries=105
control-ui-i18n: source: keys=3960
exit 0
```

Requested type gates:

```text
node scripts/run-tsgo.mjs -p tsconfig.core.json
exit 0 (no diagnostics)

node scripts/run-tsgo.mjs -p tsconfig.ui.json
exit 0 (no diagnostics)

node scripts/run-tsgo.mjs -p tsconfig.extensions.json
exit 0 (no diagnostics)

OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json
exit 0 (no diagnostics)
```

Changed gate:

```text
pnpm check:changed --staged
Blacksmith Testbox tbx_01ky7mr2xxsf79mxq8er4r3g7y
command=22m27.882s total=22m29.893s exit=0 runStatus=succeeded
```

After autoreview fixes, the final Blacksmith rerun remained capacity-queued for eight minutes and was stopped cleanly. The trusted-source fallback ran the identical staged path set locally without the slow staged-per-file `git show` mode:

```text
changed_paths=("${(@f)$(git diff --cached --name-only)}")
OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree CI=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm check:changed --base HEAD --head HEAD -- "${changed_paths[@]}"
lanes=core, coreTests, ui, apps
OPENCLAW_* count 529/529
max-lines ratchet OK: 1133 grandfathered suppressions
Control UI i18n verified: baseline entries=105, source keys=3960
Typecheck core, core tests, and UI: passed
Core, UI, packages, and Swift lint: 0 errors/violations
Mac app CI tests: 232 passed across 5 Vitest shards
Native state schema guard: v5 passed
Database-first legacy-store guard: passed
Import cycle check: 0 runtime value cycles
exit 0
```

Review and final sanity:

```text
.agents/skills/autoreview/scripts/autoreview --mode uncommitted
trufflehog: clean
autoreview clean: no accepted/actionable findings reported
overall: patch is correct (0.94)

git diff --cached --check
exit 0
```

## LOC summary

From `git show --numstat 083482ea654`, classifying `*.test.*` and `ui/src/test-helpers/**` as tests:

```text
prod 138 added, 37 deleted, net +101
test 322 added, 11 deleted, net +311
total 460 added, 48 deleted, net +412
```

The shared audit extraction is nearly LOC-neutral by moving the former sharing-only implementation into one reusable helper. The main production growth is the actor field plumbing, complete audit-failure rollback, event tombstones, protocol/UI types, and accessible archive-chip state.

## Skipped or deferred

- No live browser/source-blind validation was run. This task had no independent live Gateway/browser fixture, and the same agent was already source-aware. The Control UI DOM behavior suite provides the requested behavior-level proof, including solo dormancy.
- No SQLite schema version or migration was added because the canonical session entry is stored in `entry_json`; adding one would violate the spec and repository storage rules.
- No Kotlin generated diff was committed because the Kotlin generator does not emit `SessionRow` and produced no change.
- No ignored `dist/protocol.schema.json` was force-added; it was generated and checked, while current repository policy leaves `dist/` untracked.
- No push, PR, changelog edit, `scripts/pr`, or live Gateway mutation was performed.
- `origin/main` advanced during the long validation window. The branch is intentionally left for the reviewer to rebase as requested.
