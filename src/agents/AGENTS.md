# Agent Runtime And Tests

Own agent assembly, run authority, focused tests.

## Guardrails

- Prompts, tools, results: describe available capabilities accurately, with context for next useful action and no unnecessary model round trips. Inject cross-tool references from enabled tool set; drop stale model-facing arguments; give new optional features discovery paths.
- Test performance work: follow [openclaw-test-performance](../../.agents/skills/openclaw-test-performance/SKILL.md).
- Schema, capability, routing, static-discovery tests: lightweight typed artifacts, not cold-loaded plugin/channel/provider runtimes. Keep runtime fallbacks; isolate expensive bootstrap/runners behind injection/narrow helpers.
- Do not add direct bundled-plugin imports to agent tool tests for schema or capability assertions. If the production path needs the same data, promote a small public artifact instead.
- Spawn/session/requester-origin normalization: deterministic, runtime-free; test channel-prefix parsing. Channel descriptors: [channels](../channels/AGENTS.md).
- Model/tool selection: [availability and selection](../plugins/AGENTS.md#availability-and-selection).
- Moving slow integration coverage: preserve + test exact production composition in named helper.
- Module mocks: pass the real module through or annotate `// mock-isolation:` (`check:test-mock-exports`); reset only mutated state.
- Append transcript messages only through awaited `SessionManager.appendMessageAsync`; it assigns `parentId` and persists. Never write transcript rows directly.

## Client Capability Scope

- Attached-client tool listing uses the session's recorded operator capabilities, never the current turn or backend host flags. Execution uses current client authority and checks the live recipient; clients differ. Capabilities ≠ authorization: [client capabilities](../../docs/gateway/protocol/handshake.md#client-capabilities).
- Capability caches: connection/session lifecycles; share only process-stable provider metadata. Never select tools from another client's cached answer.
- Backend portable-artifact tools need no client merely for UI display.
- Prove differing clients on one backend, supported remote client without local UI flag, retirement of cached capabilities.

## Run Authority

- Prepare one admitted context after runtime selection; retries/fallbacks reuse it, never mint authority.
- Lifecycle owner's `finally`: close admission on terminal, error, cancellation, unsupported recovery paths.
- Harness host capabilities capture exact admitted authority. Gate tool binding/preparation/execution, hooks, approvals.
- Retained tools, preparers, callbacks, approval handles: fail after close, replacement, release, abort, claim loss, lifecycle rotation.

## Source Reply Completion

- `agent-run-terminal-reply.ts` owns terminal reply preparation and `meta.terminalReply`; every terminal producer publishes the fact and full prepared payloads. `isSilentReplyText(text)` in `auto-reply/tokens.ts` recognizes only a whole final that trims to `NO_REPLY`, ignoring casing. Producer preparation strips one leading `NO_REPLY\n`, or a standalone trailing `NO_REPLY` line, ignoring casing, and preserves the remaining answer as visible text. The leading form takes precedence; do not reclassify its suffix. Delivery, channels, and UI consume prepared output and recorded facts, never reparse text. Stored assistant readers honor display/phase/endTurn/final-source-mirror facts before the exact check on raw text; never classify user text. `resolveCommandReplyExpectation` owns result-required internal sessions. Empty finals still recover; silence does not clear failures, prove delivery, or cancel pending work. `reply-completion.ts` owns completion reconciliation; callers consume its recorded result.
- Delivery completion remains host-owned: settled, complete, non-dry-run current-source delivery. Terminal reaction: explicit `final: true` + nonempty addition to current channel/account/conversation/message. Acknowledgments, progress/removal/empty reactions, wrong targets, failures, partial delivery, no-ops, dry runs are not delivery proof; explicit silence does not depend on delivery proof.
- Current-source `final: false` text sends can complete external turns at settlement when the last tool batch ends with an empty or silent response. Work after/beside them, including asynchronous-send follow-up, keeps finalization. Result-required internal turns need a completed current-source final result; recorded progress mirrors do not satisfy that obligation.
