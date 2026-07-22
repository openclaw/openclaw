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
- Connection identity is trusted-proxy user ID first, otherwise the cryptographically paired device ID; display/operator names are labels only. Identity-less token/password/no-auth connections are owner-equivalent so solo mode cannot lock itself out.
- Admission is centralized before handler dispatch for keyed mutators, with exact target recovery for approval IDs, run IDs, board tickets, bulk group rename/delete, and the `agent` handler's final routed/default key. Admins intentionally bypass participation checks.
- Draft list/event filtering is fail-closed. Deleted rows emit a scoped event plus a redacted unscoped catalog invalidation so hidden keys stay hidden while clients still refresh.
- Visibility and member mutation plus transcript audit/rollback/publication are serialized per session. Audit entries use `SessionManager.open(...).appendMessage(...)`, never raw JSONL or a direct event write.
- There is no canonical `sessions.list` result-row schema or generated native session-row model in the current protocol registry. The additive row contract therefore lives in the shared gateway/UI `GatewaySessionRow` types; standalone sharing RPC/event schemas are generated for Swift/Kotlin.

## W1 contract assumed

W1 will add `createdBy?: { id: string; label?: string }` to `SessionEntry` and session rows. W2 consumes that property structurally without declaring, stamping, or rendering it. `id` must use the same canonical identity as enforcement: trusted-proxy user ID or paired device ID; `label` may carry the human/device display label. Until W1 lands, an identified non-admin is not inferred to own an unstamped session; `operator.admin` and identity-less solo connections remain owner-equivalent. No owner avatar, person filter, presence UI, or collaboration docs page was added here.

## Validation

- `pnpm install` — passed; lockfile already current.
- `node --import tsx scripts/control-ui-i18n-verify.ts baseline` — passed; English source and raw-copy baseline regenerated.
- `pnpm protocol:gen && pnpm protocol:gen:swift && pnpm protocol:gen:kotlin && node scripts/check-protocol-since.mjs` — passed; four new methods stamped `2026.7`.
- `pnpm db:kysely:gen && pnpm sqlite:sessions-schema:gen` — passed; generated database types/schema and session baseline refreshed.
- `pnpm config:docs:gen` followed by `pnpm config:docs:check` — passed.
- `pnpm db:kysely:check && pnpm sqlite:sessions-schema:check && pnpm ui:i18n:verify` — passed.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-vitest.mjs packages/gateway-protocol/src/schema/sessions-sharing.test.ts src/config/sessions/session-sharing-store.test.ts src/config/zod-schema.session-sharing.test.ts src/gateway/session-sharing.test.ts src/gateway/server-methods/sessions-sharing.test.ts src/gateway/server-broadcast.board.test.ts ui/src/pages/chat/components/chat-session-sharing.test.ts` — passed across gateway, gateway-client, runtime-config, and UI shards.
- `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-vitest.mjs src/gateway/server-methods-list.test.ts src/gateway/server-broadcast.board.test.ts src/gateway/server-methods/sessions-sharing.test.ts` — 22 tests passed.
- Final focused reruns after review fixes: `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-vitest.mjs src/gateway/session-sharing.test.ts src/gateway/server-methods/sessions-sharing.test.ts` and `OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=worktree node scripts/run-vitest.mjs src/gateway/server-broadcast.board.test.ts src/gateway/server-methods/sessions-sharing.test.ts` — passed.
- `node scripts/check-changed.mjs` — full Blacksmith Testbox changed-lane gate passed after the protocol schema split (run 29899825920): core/core-test/UI types, full core/UI/packages lint, native CI subset, i18n, database/schema/boundary/import-cycle guards. The final post-review rerun (29903585791) stopped at an unrelated moving-`origin/main` max-lines ratchet asking to remove stale allowlist entries for `src/agents/cli-backends.test.ts` and `src/system-agent/agent-turn.test.ts`; neither file nor the baseline is touched here, and repo policy forbids editing the baseline merely to silence that drift.
- `.agents/skills/autoreview/scripts/autoreview --mode uncommitted --stream-engine-output` — final integrated Codex review clean with no findings (`patch is correct`, confidence 0.82). Earlier accepted findings were fixed and focused proof rerun; the recurring request for a sessions-list row schema was rejected after registry/generated-model searches confirmed that surface does not exist.
- `git diff --check` — passed.

Behavior validation exercised the exported sharing schemas, real gateway handler responses and persisted transcript/member state, broadcaster filtering with nested/global agent scope, retry/rollback concurrency, and rendered Control UI menu DOM. A packaged live multi-identity deployment was not run because W1 ownership stamping is still in flight; the behavior-level gateway tests use explicit trusted-proxy/device identities and cover the solo fallback.

## Skipped and non-goals

- No suggestion queue, typing indicator, invite/request flow, draft promotion/create-as-draft affordance, owner avatar/person filter, or W1 docs page.
- No `CHANGELOG.md` edit, protocol-version bump, SQLite schema-version bump, dependency change, push, PR, or GitHub comment.
- SwiftLint was unavailable on the Linux Testbox; the changed gate explicitly delegated that coverage to macOS CI. Generated Swift/Kotlin output and protocol since checks passed.
- The branch was left on `feat/session-visibility-membership` without rebasing the moving `origin/main`; W1 integration is expected to rebase later.
