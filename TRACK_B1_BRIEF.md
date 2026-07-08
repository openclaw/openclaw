# Track B1+B4+B5: truthful run liveness — delete fake evidence, honest recovery attribution, evidence-aged steer capture

Design issue: https://github.com/openclaw/openclaw/issues/101863 (Track B design comment). This branch is stacked on `fix/reply-run-terminal-release` (PR #101910, Track A) and uses its primitives: `ReplyOperation.lastActivityAtMs`, `recordActivity()`, `expireStaleReplyOperation()`, failure code `"run_stalled"`, constant `REPLY_RUN_STALE_TAKEOVER_MS` — all in `src/auto-reply/reply/reply-run-registry.ts`. This brief is authoritative for scope.

## B1 — delete the CLI timer heartbeat; phase-aware tool-stall floor

Problem (verified): `startClaudeLiveActiveToolHeartbeat` (`src/agents/cli-runner/claude-live-session.ts:551-566`) emits `cli_live:tool_running` on a 10s `setInterval` while a tool is merely _marked_ active (`turn.activeTools.size > 0`). That flows via `emitClaudeLiveProgress` → `run.progress` → `touchSessionActivity` (`src/logging/diagnostic-run-activity.ts:185`), resetting `lastProgressAt` with zero evidence the CLI child is alive. Consequence (#96168): the `blocked_tool_call` classifier branch (`src/logging/diagnostic-session-attention.ts:55-67`) — which correctly requires BOTH `activeToolAgeMs > staleMs` AND `lastProgressAgeMs > staleMs` — can never fire for a wedged CLI tool, and neither can any stuck-recovery abort gate keyed on `lastProgressAgeMs`.

Fix:

1. Delete the heartbeat entirely: `startClaudeLiveActiveToolHeartbeat`, `CLAUDE_LIVE_ACTIVE_TOOL_PROGRESS_MS` (`claude-live-session.ts:112`), the start call (~`:598`), the stop calls (~`:568`, `:654`), turn-cleanup clearing (~`:390`), and the `cli_live:tool_running` reason string. Real frames already stamp progress: tool start (`:597`), tool result (`:612`, `:653`), terminal result (`:711`), and any stdout frame via `noteClaudeLiveProgress` (`:705`, `:717`). Do NOT touch the byte-level no-output watchdog (`resetNoOutputTimer` `:720-738`) — it is evidence-based and correct.
2. Deleting the fake stamp re-exposes the #88870 hazard: a legitimately quiet long tool would become abort-eligible at the default `stuckSessionAbortMs` (~6 min). Add a tool-phase abort floor in `src/logging/diagnostic.ts`:
   - New constant next to the other thresholds (`diagnostic.ts:80-85`): `BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000`, with a 2-3 line contract comment: quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills truly-silent children at ≤600s; this floor only governs diagnostic recovery aborts for chatty-but-stuck turns; too low re-creates #88870, removal re-creates #96168's motivation for fake heartbeats.
   - Apply in `isBlockedToolCallRecoveryEligible` (`diagnostic.ts:514`): eligibility requires `lastProgressAgeMs >= Math.max(stuckSessionAbortMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)` (only for the tool_call kind — do not change model_call or embedded_run gates).
   - The warn-level classification (`classifySessionAttention` blocked_tool_call branch) keeps current thresholds — early warning naming the tool is good UX and cheap.
3. Delete tests asserting the removed heartbeat behavior (they protect a removed path); update wedged-tool tests so a stuck tool with no frames becomes stale → classified → recovery-eligible after the floor.

## B4 — honest recovery attribution + stall-proof heartbeat math

Problem 1 (verified): a diagnostic stuck-recovery abort of a reply-backed run routes `abortAndDrainEmbeddedAgentRun` → `abortReplyRunBySessionId` (`reply-run-registry.ts:856`) → `operation.abortByUser()` (`:664`) which stamps `abortedCode: "aborted_by_user"` (`:671`). Watchdog kills surface to the user as their own abort (#88870's misattribution).

Fix: recovery is a staleness expiry, and Track A already built the primitive. In `src/logging/diagnostic-stuck-session-recovery.runtime.ts` (and the runs.ts abort leg it calls), when recovery decides to abort/force-clear a **reply-registry-owned** operation, route it through `expireStaleReplyOperation(operation, ...)` instead of `abortByUser()`/plain `fail("run_failed")`, so the terminal result is `{kind:"failed", code:"run_stalled"}` and the takeover log names the reason. Extend the `ReplyOperationStaleReason` union with `"stuck_recovery"` (closed union — check every consumer). For embedded (non-reply) runs, keep `abortAndDrainEmbeddedAgentRun` but ensure the abort reason threading does not produce a user-abort-shaped terminal outcome: check `resolveAgentRunAbortLifecycleFields` / terminal-outcome normalization (`src/agents/agent-run-terminal-outcome.ts`) and make the stuck-recovery abort distinguishable (a recovery-tagged abort error is acceptable; do not invent new lifecycle phases). Do not change the recovery module's detection logic beyond this routing.

Problem 2 (verified, #101670): all staleness ages are raw `Date.now()` deltas; the 30s heartbeat (`diagnostic.ts:1211`) computes `ageMs = now - state.lastActivity` (`:1281`) after an event-loop stall and reads the stall as session staleness.

Fix: the heartbeat records its own last tick timestamp. When a tick arrives later than ~3× the interval (>90s), that tick logs a warn (`liveness heartbeat delayed <n>ms; deferring recovery decisions`) and performs NO recovery/abort scheduling — classification/warn logging may still run. The next on-time tick proceeds normally. One module-local variable, one guard, one contract comment (a delayed tick means the process stalled, not the sessions; acting on inflated ages aborts healthy runs). Test with fake timers.

## B5 — steer capture refuses evidence-stale runs

Problem (proven live in PR #101910's E2E): steer acceptance checks only streaming/stopped state, so a wedged run swallows its own rescue messages before reply admission can evaluate Track A's stale takeover.

Fix, two gates:

1. `queueReplyRunMessage` (`reply-run-registry.ts:839-854`): refuse (return false) when `Date.now() - operation.lastActivityAtMs > REPLY_RUN_STALE_TAKEOVER_MS`. A refused caller already falls back to normal followup queueing → admission → Track A reclaim. Contract comment: steering into an evidence-dead run swallows the human message that would otherwise trigger stale takeover.
2. `prepareEmbeddedAgentQueueMessage` (`src/agents/embedded-agent-runner/runs.ts:437-499`): after the injectable check, refuse when the session's diagnostic activity evidence is stale: use `getDiagnosticSessionActivitySnapshot` (`src/logging/diagnostic-run-activity.ts:572`) `lastProgressAgeMs` (when available) `>` a local `EMBEDDED_STEER_STALE_CAPTURE_MS = 10 * 60_000` constant (src/agents must not import src/auto-reply; duplicate the value with a comment naming `REPLY_RUN_STALE_TAKEOVER_MS` as the paired constant). New closed failure reason `"stale_run"` added to `EmbeddedAgentQueueFailureReason` (`runs.ts:56-62`) — check every consumer of that union handles it (sessions-send-tool.ts, subagent-announce-delivery.ts, etc.; they should treat it like `no_active_run`/`not_streaming` fall-through). If no diagnostic snapshot exists (diagnostics disabled), skip the gate (status quo).

- Non-goal: draining already-captured steer entries from a dead handle (Track C durability).

## Non-goals (do not touch)

- Codex app-server watches (`extensions/codex`) — separate Track B2 PR.
- `llm-idle-timeout.ts` / `timeout.ts` semantics — separate Track B3 PR.
- No new config keys or env vars; constants only. `stuckSessionWarnMs`/`stuckSessionAbortMs` keep their meaning.
- No changes to the CLI byte-level no-output watchdog or supervisor.
- No user-visible message wording work beyond what attribution requires (Track D owns messaging).

## Repo conventions

- TS ESM strict, no `any`, closed unions/codes. Comments: 1-3 lines, contract + bad outcome if removed, at lifecycle/threshold/ownership points only.
- Tests colocated, Vitest, fake timers cleaned up, `--isolate=false` safe. Delete tests of removed paths rather than porting them.
- Keep LOC tight; B1 should be clearly net-negative (a whole heartbeat mechanism disappears).

## Required tests

1. CLI wedged-tool: tool started, no further frames → `lastProgressAgeMs` grows (no timer stamps exist anymore), `blocked_tool_call` classification fires, recovery becomes eligible only after `max(stuckSessionAbortMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)`.
2. CLI active-tool with real frames (tool result / stream frames arriving) → never classified stalled.
3. Recovery abort of a reply-owned stale run → operation result `{failed, run_stalled}`, NOT `aborted_by_user`; user-abort path still yields `aborted_by_user`.
4. Delayed heartbeat tick (fake timers, simulate >90s gap) → no recovery scheduled that tick, warn logged, next tick recovers normally.
5. `queueReplyRunMessage` refuses when `lastActivityAtMs` stale, accepts when fresh (recordActivity just called).
6. `prepareEmbeddedAgentQueueMessage` returns `"stale_run"` when diagnostic evidence stale; accepts when fresh; skips gate when no snapshot.
7. Consumers of `EmbeddedAgentQueueFailureReason` handle `"stale_run"` (compile-time exhaustiveness + behavior fall-through where tested).

## Validation before you commit

- `node scripts/run-vitest.mjs src/logging src/agents/cli-runner src/auto-reply/reply src/agents/embedded-agent-runner` relevant test files (start with the directly touched test files, then the import sweep below). Never bare `pnpm test`/`vitest`.
- Import sweep: `rg -l 'claude-live-session|diagnostic-run-activity|diagnostic-session-attention|stuck-session-recovery|queueEmbeddedAgentMessage|queueReplyRunMessage|EmbeddedAgentQueueFailureReason' --glob '*.test.ts' src test` and run those files.
- Typecheck: `node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo` and the core-test lane; check exit codes directly, no pipes.
- Format touched files with `node_modules/.bin/oxfmt`; lint with `node scripts/run-oxlint.mjs <files>`.

Commit on this branch with a conventional message (e.g. `fix(agents): replace fake CLI liveness with evidence-based stall detection`). Do not push. Do not open a PR. Write design decisions + test results to `TRACK_B1_NOTES.md` at the worktree root.
