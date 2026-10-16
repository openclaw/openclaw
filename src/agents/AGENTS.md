# Agent Runtime And Tests

Own agent assembly, run authority, focused tests. Slow, import-bound tests = architecture signals.

## Guardrails

- Performance edits: benchmark before/after; reuse grouped artifacts or `/usr/bin/time -l pnpm test <file>`. Report seconds + RSS.
- Schema, capability, routing, static-discovery tests: lightweight typed artifacts, not cold-loaded plugin/channel/provider runtimes. Keep runtime fallbacks; isolate expensive bootstrap/runners behind injection/narrow helpers.
- Hot paths: pure helpers/lightweight public artifacts for target parsing, peer-kind inference, setup hints, descriptors before `getChannelPlugin()`/bundled runtime. Spawn/session/requester-origin normalization: deterministic, runtime-free; test channel-prefix parsing.
- Prepared model/tool selection: follow plugin owner's [availability and selection contract](../plugins/AGENTS.md#availability-and-selection). Discovery outside repeated selection; user-requested model/tool execution remains allowed.
- Moving slow integration coverage: preserve + test exact production composition in named helper.
- Avoid broad `importOriginal()` partial mocks/module resets. Explicit factories, one-time imports; reset only mutated state.

## Client Capability Scope

- Attached-client tools: current connection/session capabilities, never backend host flags; clients differ.
- Capability caches: connection/session lifecycles; share only process-stable provider metadata. Never select tools from another client's cached answer.
- Availability ≠ authorization: preserve server validation, tool grants, live authority. Backend portable-artifact tools need no client merely for UI display.
- Prove differing clients on one backend, supported remote client without local UI flag, retirement of cached capabilities.

## Run Authority

- Prepare one admitted context after runtime selection; retries/fallbacks reuse it, never mint authority.
- Lifecycle owner's `finally`: close admission on terminal, error, cancellation, unsupported recovery paths.
- Harness host capabilities capture exact admitted authority. Gate tool binding/preparation/execution, hooks, approvals; revalidate after awaits before results cross action boundary.
- Retained tools, preparers, callbacks, approval handles: fail after close, replacement, release, abort, claim loss, lifecycle rotation.

## Source Reply Completion

- `agent-run-terminal-reply.ts` owns terminal reply preparation and `meta.terminalReply`; every terminal producer publishes the fact and full prepared payloads. `isSilentReplyText(text)` in `auto-reply/tokens.ts` recognizes only a whole final that trims to uppercase `NO_REPLY`. Producer preparation strips one literal leading `NO_REPLY\n`, or a standalone exact trailing `NO_REPLY` line, and preserves the remaining answer as visible text. The leading form takes precedence; do not reclassify its suffix. Delivery, channels, and UI consume prepared output and recorded facts, never reparse text. Stored assistant readers honor display/phase/endTurn/final-source-mirror facts before the exact check on raw text; never classify user text. `resolveCommandReplyExpectation` owns result-required internal sessions. Empty finals still recover; silence does not clear failures, prove delivery, or cancel pending work. `reply-completion.ts` owns completion reconciliation; callers consume its recorded result.
- Delivery completion remains host-owned: settled, complete, non-dry-run current-source delivery. Terminal reaction: explicit `final: true` + nonempty addition to current channel/account/conversation/message. Acknowledgments, progress/removal/empty reactions, wrong targets, failures, partial delivery, no-ops, dry runs are not delivery proof; explicit silence does not depend on delivery proof.
- Current-source `final: false` text sends can complete external turns at settlement when the last tool batch ends with an empty or silent response. Work after/beside them, including asynchronous-send follow-up, keeps finalization. Result-required internal turns need a completed current-source final result; recorded progress mirrors do not satisfy that obligation.

## Verification

- Root proof policy: narrow trusted local proof, broad PR CI. Lazy-loading, plugin-runtime import, or bundled-artifact changes: `pnpm build` required.
