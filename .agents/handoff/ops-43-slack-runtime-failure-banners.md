# OPS-43 — Slack runtime: stale recovered-failure banners leak into final answers

Tracking issue: https://github.com/norfolkaibi/openclaw-ops/issues/43
Branch: `fix/ops-43-slack-runtime-failure-banners`
Surface: `extensions/codex/src/conversation-turn-collector.ts` (native Codex conversation binding → Slack reply)

## Problem

When a Codex conversation binding turn recovers from an internal failure but still
produces a final assistant answer, Slack shows the raw turn-failure banner
("Codex app-server turn failed: …") instead of the recovered answer.

## Root cause (proven against sibling `../codex` source, not memory)

Codex app-server `bespoke_event_handling.rs`:

- `handle_turn_complete` (~:1512): `turn.status` is `Failed` **iff** `turn_summary.last_error`
  is `Some`, otherwise `Completed`.
- `last_error` is set by `handle_error` (~:1642), reached from `EventMsg::Error` **only when**
  `ev.affects_turn_status()` is true (`:944`). `affects_turn_status` (protocol.rs:1711) is true
  for sandbox/stream/usage/context/server errors. Retryable `StreamError`s deliberately do NOT
  set it (`:962`).
- `last_error` is **never cleared on recovery** — only `mem::take`-n at turn completion (`:1500`).

Consequence: an `affects_turn_status` error firing mid-turn (e.g. a sandbox/command error the
model then works around) leaves `last_error` set, so the `turn/completed` notification arrives
with `status: "failed"` **and** `turn.items` still containing the final `agentMessage`. Pure
command/tool item failures never call `handle_error`, confirming these are recovered _internal_
failures, not turn-fatal ones.

The collector collects that recovered final message, then `finish()` discards it and rejects
with the raw error, which the binding renders as the Slack failure banner.

## Fix

In `conversation-turn-collector.ts`, compute the terminal outcome once and prefer a recovered
final answer over the failure:

- If the turn failed **but** a non-empty reply text was collected → resolve with that text
  (recovered/internal failure stays out of the user-visible answer; it is not surfaced as a raw
  banner and cannot contradict the successful outcome).
- If the turn failed **and** no reply text exists → reject with the error (true unrecovered
  failure stays visible).
  Apply the same logic to the already-`completed` fast path in `wait()`.

Debug details remain available: the collector is only the reply-text extractor; the failed
command/error items still flow through Codex's own thread history/trajectory and any other
notification handlers — this change does not suppress them.

## Sibling surfaces

- `app-server/bounded-turn.ts` intentionally hard-fails on `status === "failed"`: it is an
  internal media/search helper whose callers require a clean turn and must not accept a recovered
  partial answer. Left unchanged on purpose (one-sided fix is justified, not accidental).

## Tests (conversation-turn-collector.test.ts)

1. Recovered: `turn/completed` failed + final `agentMessage` item present → resolves with the
   recovered text (no reject).
2. Recovered via streamed deltas: deltas then `turn/completed` failed with empty items →
   resolves with the delta text.
3. Recovered before `wait()`: failed-with-message completes pre-`wait()` → fast path resolves.
4. Unrecovered preserved: existing "rejects failed turns…" test (failed + no message) still rejects.

## Verification

`node scripts/run-vitest.mjs extensions/codex/src/conversation-turn-collector.test.ts`
(worktree is a linked checkout → use the node wrapper, not local `pnpm test`).
