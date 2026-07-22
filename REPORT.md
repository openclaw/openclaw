# W2 implementation report

## Scope completed

Implemented phase 2 of openclaw/openclaw#112499: additive session visibility, per-agent SQLite membership, gateway admission and draft broadcast/list enforcement, the `session.sharing` admin policy, transcript audit notes, protocol generation, and the minimal Control UI picker/editor/restricted-state presentation. Phase 3 suggestion queues/typing and phase 4 draft promotion/create UX were intentionally not added.

## Files changed

- Session state and SQLite: `src/config/sessions/types.ts`, `src/config/sessions/session-accessor.sqlite-entry-store.ts`, `src/config/sessions/session-sharing-store.ts`, `src/state/openclaw-agent-schema.sql`, generated agent schema/Kysely files, and the lazy schema ensure in `src/state/openclaw-agent-session-sharing-schema.ts`.
- Protocol: `packages/gateway-protocol/src/schema/sessions-sharing.ts`, protocol barrels/validators, four appended core method descriptors, the `session.sharing` event, and regenerated Swift/Kotlin gateway models.
- Gateway: `src/gateway/session-sharing.ts`, `src/gateway/server-methods/sessions-sharing.ts`, central request admission, resolved `agent`-route admission, list filtering, event-scope filtering, group bulk-mutation checks, redacted delete/catalog invalidation, and session-row/event projection.
- Config/docs: `session.sharing.{readOnly,suggest,drafts}` types, Zod, help/labels/tags, generated config baselines, and `docs/gateway/config-agents.md`.
- Control UI: caller-relative visibility/role row fields, header sharing menu, paired-identity membership editor, restricted composer/approval/steering behavior, draft ghost/fade presentation, English strings, CSS, and focused UI tests.
- Tests: protocol, config, SQLite lazy ensure/member CRUD, admission/identity/solo mode, indirect and bulk targets, alias/event filtering, audit persistence/rollback concurrency, broadcaster scoping, method catalog ordering, and UI menu behavior.

## Decisions

- Used `session.sharing` under the existing singular `session` config root instead of creating a competing top-level `sessions` root.
- Missing stored visibility is read as `shared`; every session-entry write materializes `shared`, so new sessions always start shared without a schema-version bump.
- Membership is a lazy additive `session_members` table in the per-agent database. The canonical schema declares it, while current-version database open excludes it until first feature use.
- Connection identity comes exclusively from the admission-prepared `operatorIdentity` (trusted-proxy user ID first, otherwise the cryptographically paired device ID); display/operator names are labels only. Connections without that canonical identity are owner-equivalent so solo mode cannot lock itself out.
- Admission is centralized before handler dispatch for keyed mutators, with exact target recovery for approval IDs, run IDs, board tickets, bulk group rename/delete, and the `agent` handler's final routed/default key. Admins intentionally bypass participation checks.
- Draft list/event filtering is fail-closed. Deleted rows emit a scoped event plus a redacted unscoped catalog invalidation so hidden keys stay hidden while clients still refresh.
- Visibility and member mutation plus transcript audit/rollback/publication are serialized per session. Audit entries use `SessionManager.open(...).appendMessage(...)`, never raw JSONL or a direct event write.
- There is no canonical `sessions.list` result-row schema or generated native session-row model in the current protocol registry. The additive row contract therefore lives in the shared gateway/UI `GatewaySessionRow` types; standalone sharing RPC/event schemas are generated for Swift/Kotlin.

## Creator contract integration

PR #112658 landed as `cf2f5911610` while this branch was being rebased. W2 now reuses its canonical `SessionCreatorIdentitySchema`, reads `SessionEntry.createdBy` directly, and resolves the caller exclusively through `gatewayClientSessionCreator()`'s admission-prepared `operatorIdentity`. A caller is the owner only when its identity matches `createdBy.id`; connections without that canonical identity remain owner-equivalent for solo compatibility. The landed owner chip, person filter, creator persistence, and creator projections stay W1-owned; W2 excludes the immutable owner from its mutable member picker instead of duplicating those controls.

## Validation

- `pnpm install` — passed; lockfile already current.
- Final rebase is onto `origin/main` at `80aaaeea3e1`, which contains #112658's merge commit `cf2f5911610`. The initial fetch saw #112658 still open; it landed during validation, so the branch was rebased again and the interim structural creator fallback was removed. Two later no-conflict rebases picked up provider/state and Android-only main updates.
- Rebase conflicts resolved:
  - Protocol/config: combined current main's `sessions.observer.visibility` method with the four appended sharing methods in the TypeScript catalogs and regenerated Swift/Kotlin output; regenerated the config count/hash baselines rather than hand-merging them.
  - Control UI: preserved current main's archived-session banner and observer-visibility callback while applying viewer participation blocking, sharing row fields, and sharing strings.
  - Creator projection: combined #112658's `createdBy` projection in `src/gateway/session-utils.ts` and `src/gateway/session-utils.types.ts` with W2's `visibility`/`sharingRole` projection, then switched enforcement to the landed identity helper and schema.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-vitest.mjs packages/gateway-protocol/src/schema/sessions-sharing.test.ts src/config/sessions/session-sharing-store.test.ts src/config/zod-schema.session-sharing.test.ts src/gateway/session-sharing.test.ts src/gateway/server-methods/sessions-sharing.test.ts src/gateway/server-broadcast.board.test.ts src/gateway/server-methods-list.test.ts src/auto-reply/reply/session-creator.test.ts src/gateway/server.sessions.create.test.ts src/gateway/session-utils-creators.test.ts ui/src/pages/chat/components/chat-session-sharing.test.ts ui/src/pages/chat/components/chat-pane-header.test.ts` — final post-integration rerun passed 110 tests across five shards. It covers identity-less solo mode, the admission-prepared operator identity, typed `createdBy` ownership, creator stamping/projection, scoped `sessions.changed` broadcasts, the membership picker, and the shared header owner chip.
- After the final no-conflict rebase, the 36-test sharing bundle passed again across four shards, and `src/gateway/server.sessions.create.test.ts` passed all 56 tests in its intended isolated run. One over-combined local gateway invocation hit a transient failure in an unrelated worktree-creation case; the isolated rerun and the earlier 110-test integrated run were green.
- Ownership UI E2E on Blacksmith Testbox `tbx_01ky4yd9b6jtys6cmy52cvy6wt`, Actions run 29921766791 — 2 tests passed: permanent owner chips/person filtering work and single-creator solo mode renders no ownership chrome.
- `node --import tsx scripts/protocol-gen.ts`, `protocol-gen-swift.ts`, `protocol-gen-kotlin.ts`, and `node scripts/check-protocol-since.mjs` — passed with no generated drift; four new methods remain stamped `2026.7`.
- `node --import tsx scripts/generate-config-doc-baseline.ts --check` — passed after regeneration (`config-baseline.sha256` and counts current).
- `node --import tsx scripts/control-ui-i18n-verify.ts baseline` and `verify` — passed; English source/raw-copy baseline current with 3,946 keys.
- `node scripts/check-changed.mjs` — Blacksmith Testbox changed-lane gate passed on run 29921812499 (21m02s command, exit 0): core/core-test/UI typechecks, full core/UI/packages lint, native CI subset, i18n, SQLite/schema/boundary/import-cycle and database-first guards. Its patch is identical to the two later no-conflict rebases; focused tests plus protocol/config/i18n drift checks were rerun on `80aaaeea3e1`. SwiftLint was unavailable on the Linux Testbox and remains owned by macOS CI. The earlier run 29920488461 was intentionally stopped after #112658 landed and invalidated its base mid-run; it was superseded, not a code-gate failure.
- `.agents/skills/autoreview/scripts/autoreview --mode uncommitted --stream-engine-output` — canonical creator integration review clean with no findings (`patch is correct`, confidence 0.90).
- `git diff --check` — passed.

Behavior validation exercised the exported sharing schemas, real gateway handler responses and persisted transcript/member state, broadcaster filtering with nested/global agent scope, retry/rollback concurrency, canonical admission-prepared identities, matched/mismatched `createdBy`, identity-less owner equivalence, and rendered Control UI menu DOM. A packaged live multi-identity deployment was not run.

## Skipped and non-goals

- No suggestion queue, typing indicator, invite/request flow, or draft promotion/create-as-draft affordance. W2 does not duplicate the owner avatar, person filter, or multi-user docs now supplied by #112658.
- No `CHANGELOG.md` edit, protocol-version bump, SQLite schema-version bump, dependency change, push, PR, or GitHub comment.
- SwiftLint was unavailable on the Linux Testbox; the changed gate explicitly delegated that coverage to macOS CI. Generated Swift/Kotlin output and protocol since checks passed.
- The branch is left on `feat/session-visibility-membership`, rebased onto `origin/main` at `80aaaeea3e1` (including #112658), with no push performed.
