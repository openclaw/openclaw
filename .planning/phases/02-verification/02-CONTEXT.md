# Phase 2: Verification - Context

**Gathered:** 2026-09-10
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — no discussion needed)

This is a pure infrastructure/verification phase. The phase goal keywords ("verify", "check", "test") and all success criteria are technical (checks pass, tests pass, typecheck passes). No user-facing behavior is described, so no grey areas require discussion.

## Phase Boundary

Verify all Phase 1 changes with appropriate proof. The focus is running the appropriate test suites and check gates for the talk/queue subsystem changes across two subsystems: `src/gateway/` (server-side) and `ui/src/pages/chat/` (client-side).

## Locked Requirements

From `.planning/REQUIREMENTS.md` v1 and `.planning/ROADMAP.md` Phase 2 success criteria:

1. `pnpm check:changed` passes (assertion-SAFETY ratchet, max-lines ratchet, import-cycles, etc.)
2. `pnpm typecheck` passes with strict types
3. Focused tests pass: all talk/queue related test files
4. Full test suite run for affected subsystems

## Implementation Decisions

### Claude's Discretion

All implementation choices are at Claude's discretion — pure infrastructure verification phase. Execute the test scripts and check gates directly, capture output, and write the VERIFICATION.md report.

## Existing Code Insights

### Changed Production Files

**UI (client-side `ui/src/pages/chat/`):**

- `realtime-talk-shared.ts` — core fix: `waitForEmptyFinalFallback` preserves follow-up runId, bounded buffer integration
- `realtime-talk-chat-handler.ts` — `createChatHandler`, `matchesActiveRun`, `bufferEvent` with bounds (`MAX_BUFFERED_TERMINAL_EVENTS=4`, `MAX_BUFFERED_BYTES=64*1024`), `replayBufferedFollowupEvents`
- `realtime-talk-followup-observation.ts` — `AgentWaitResult`, `observePendingFollowupRunId` polling (FOLLOWUP_POLL_INTERVAL_MS=2000)

**Gateway (server-side `src/gateway/`):**

- `server-lifecycle.ts` — `retiredFollowupRunIds` Map creation + lifecycle chain plumbing (lines 88, 675)
- `server-request-context.ts` — `retiredFollowupRunIds` in `GatewayRequestContextRuntime` type (line 70, line 495 runtime)
- `chat-queued-turns.ts` — server-side retired follow-up turn tracking
- `server-maintenance.ts` — maintenance timers with `retiredFollowupRunIds`
- `server-core-runtime.ts`, `server-runtime-state-prepare.ts`, `server-startup-early.ts` — runtime state plumbing
- `server-connection-state.ts`, `local-request-context.ts` — connection/request context types

### Test Configurations

- **UI tests**: `test/vitest/vitest.ui.config.ts` — covers `ui/src/pages/chat/*realtime-talk*.test.ts`, uses `jsdom` environment
- **Gateway server tests**: `test/vitest/vitest.gateway-server.config.ts` — covers `src/gateway/**/*server*.test.ts` (fileParallelism: false)
- **Gateway methods tests**: `test/vitest/vitest.gateway-methods.config.ts` — covers `src/gateway/server-methods/**/*.test.ts`

### Test Commands

- `pnpm test:ui` — runs UI test shard via `pnpm --dir ui test`
- `pnpm test:gateway` — runs gateway test shard via `node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts`
- `pnpm check:changed` — runs all changed-file ratchets (assertion-SAFETY, max-lines, import-cycles, format, etc.)
- `pnpm typecheck` — `tsc --noEmit` (strict TypeScript ESM)

### Prior Phase Context

Phase 1 decisions are locked in `.planning/phases/01-fix-implementation/01-CONTEXT.md`. The core security detail for verification: `retiredFollowupRunIds` Map-based correlation replaces the insecure `acceptingAnyRunId` wildcard. The bounded buffer (`MAX_BUFFERED_TERMINAL_EVENTS=4`, `MAX_BUFFERED_BYTES=64*1024`) rejects on overflow rather than silently dropping. Import cycle was broken by moving `AgentWaitResult` to `realtime-talk-followup-observation.ts`.

### Pre-existing Environmental Failure

The `bundled channel config metadata` check (`check:bundled-channel-config-metadata`) fails due to a missing `node_modules/@openclaw/ai/dist/internal/shared.mjs` build artifact. This is confirmed pre-existing/environmental (reproduced on a clean tree with all changes stashed). Not caused by this branch; resolves with a proper `pnpm install && pnpm build` in CI. Verify that this same failure appears in Phase 2 and document it as environmental.

## Deferred Ideas

(None — this phase is purely verification, no new capabilities to defer.)

## Canonical Refs

- `.planning/phases/01-fix-implementation/01-CONTEXT.md` — Phase 1 locked decisions
- `.planning/phases/01-fix-implementation/01-VERIFICATION.md` — Phase 1 verification report
- `ui/src/pages/chat/realtime-talk-shared.ts` — core fix: `waitForEmptyFinalFallback`
- `ui/src/pages/chat/realtime-talk-chat-handler.ts` — `matchesActiveRun`, bounded `bufferEvent`
- `ui/src/pages/chat/realtime-talk-followup-observation.ts` — `AgentWaitResult`, `observePendingFollowupRunId`
- `src/gateway/server-request-context.ts` — `retiredFollowupRunIds` type declaration
- `src/gateway/server-lifecycle.ts` — lifecycle plumbing
- `src/gateway/chat-queued-turns.ts` — server-side retired follow-up tracking
- `test/vitest/vitest.ui.config.ts` — UI test configuration
- `test/vitest/vitest.gateway-server.config.ts` — Gateway server test configuration
- `test/vitest/vitest.gateway-methods.config.ts` — Gateway methods test configuration
- `config/assertion-safety-baseline.txt` — assertion SAFETY ratchet baseline
