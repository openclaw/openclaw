Focus on the automatic Daybreak cyber-failover added to the Codex harness.

Key files:

- extensions/codex/harness.ts (runAttempt wrapper: sticky pre-route, single
  escalation retry, window recording, notice emission)
- extensions/codex/src/app-server/cyber-failover.ts (config, in-memory session
  window, refusal/unavailability detection, planning)
- extensions/codex/src/app-server/cyber-failover-notice.ts
- ui/src/pages/chat/tool-stream.ts (provider_policy notice state machine)

Intended contract:

- A turn refused with OpenAI's cyber policy is retried at most once on the
  configured Daybreak model. Never loop.
- Escalation is turn-local via runtimeModelId; it must not change the session's
  stored model selection.
- After an attempt the session gets a bounded in-memory window. Only a Daybreak
  reply ("answered") pre-routes later turns; unauthorized or still-refused
  ("suppressed") only blocks further attempts.
- An unauthorized Daybreak target (HTTP 401/403) must degrade to the original
  refusal plus an explicit notice, and must not be retried inside the window.
- Bio and misalignment refusals must be untouched.

Please look hard at: concurrency/interleaving of the shared module-level window
map across sessions and parallel turns, unbounded growth of that map, whether
the escalated attempt can double-emit transcript/assistant rows or duplicate
side effects already performed by the refused attempt, and whether the UI notice
state machine can strand or mis-order states.
