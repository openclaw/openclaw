# Mission 10 — Partial Path Call-Chain Proof

## 1. Title

Mission 10 bounded call-chain proof for remaining partial paths.

## 2. Scope

Strict scope (only):

- WS `chat.send`
- HTTP `POST /v1/chat/completions`

Goal: prove whether each path reaches the selected provider-lane boundary and whether a second admission hook is required.

## 3. VERIFIED

- WS message flow calls `handleGatewayRequest` from `src/gateway/server/ws-connection/message-handler.ts`.
- `handleGatewayRequest` dispatches to `chatHandlers` in `src/gateway/server-methods.ts`.
- `chatHandlers["chat.send"]` calls `dispatchInboundMessage` in `src/gateway/server-methods/chat.ts`.
- `dispatchInboundMessage` calls `dispatchReplyFromConfig` in `src/auto-reply/dispatch.ts`.
- `dispatchReplyFromConfig` attempts `tryDispatchAcpReply(...)` and returns early when ACP dispatch handles the turn in `src/auto-reply/reply/dispatch-from-config.ts`.
- Non-ACP reply flow reaches `runPreparedReply` -> `runReplyAgent` -> `runAgentTurnWithFallback` -> `runEmbeddedPiAgent` across:
  - `src/auto-reply/reply/get-reply.ts`
  - `src/auto-reply/reply/get-reply-run.ts`
  - `src/auto-reply/reply/agent-runner.ts`
  - `src/auto-reply/reply/agent-runner-execution.ts`
- `runEmbeddedPiAgent` enqueues provider-lane work via `enqueueCommandInLane(provider:<id>, ...)` in `src/agents/pi-embedded-runner/run.ts`.
- HTTP `/v1/chat/completions` entry is handled by `handleOpenAiHttpRequest` in `src/gateway/openai-http.ts`.
- `handleOpenAiHttpRequest` directly calls `agentCommand` (streaming and non-streaming paths) in `src/gateway/openai-http.ts`.
- In `agentCommand`, ACP-ready sessions run via `acpManager.runTurn(...)`; non-ACP path runs `runAgentAttempt(...)` -> `runEmbeddedPiAgent(...)` in `src/commands/agent.ts`.

## 4. LIKELY

- Both target paths can reach provider-lane boundary when execution follows non-ACP embedded run paths.
- In ACP-ready sessions, provider-lane boundary selected for this mission (`runEmbeddedPiAgent` provider lane) may be bypassed.
- Existing selected admission points appear sufficient as boundary points; no hard evidence in this pass that a second admission hook is required.

## 5. UNKNOWN

- Whether ACP execution paths have an equivalent provider-concurrency boundary that should replace/augment `runEmbeddedPiAgent` lane assumptions.
- Exact runtime frequency split between ACP and non-ACP branches for these two paths.

## 6. `chat.send` call-chain proof

- entry surface:
  - WS request frame -> `handleGatewayRequest` -> `chatHandlers["chat.send"]`
- call chain:
  - `src/gateway/server/ws-connection/message-handler.ts` -> `handleGatewayRequest`
  - `src/gateway/server-methods.ts` -> handler dispatch
  - `src/gateway/server-methods/chat.ts` -> `dispatchInboundMessage`
  - `src/auto-reply/dispatch.ts` -> `dispatchReplyFromConfig`
  - branch A (ACP): `tryDispatchAcpReply` returns handled result (early return)
  - branch B (non-ACP): `getReplyFromConfig` -> `runPreparedReply` -> `runReplyAgent` -> `runAgentTurnWithFallback` -> `runEmbeddedPiAgent`
- selected admission point:
  - `handleGatewayRequest` (`src/gateway/server-methods.ts`)
- selected provider-lane point:
  - provider-lane enqueue in `runEmbeddedPiAgent` (`src/agents/pi-embedded-runner/run.ts`)
- proof status:
  - INDIRECT
- duplicate-hook risk:
  - POSSIBLE
- coverage conclusion:
  - PARTIAL

Unproven remainder:

- For ACP-handled `chat.send` turns, direct reachability to the selected provider-lane boundary is not proven because execution can terminate in ACP dispatch path before embedded runner execution.

## 7. `/v1/chat/completions` call-chain proof

- entry surface:
  - HTTP `POST /v1/chat/completions` -> `handleOpenAiHttpRequest`
- call chain:
  - `src/gateway/server-http.ts` -> `handleOpenAiHttpRequest`
  - `src/gateway/openai-http.ts` -> `agentCommand` (stream and non-stream)
  - branch A (ACP-ready session): `src/commands/agent.ts` -> `acpManager.runTurn`
  - branch B (non-ACP): `src/commands/agent.ts` -> `runAgentAttempt` -> `runEmbeddedPiAgent`
- selected admission point:
  - `handleOpenAiHttpRequest` (`src/gateway/openai-http.ts`)
- selected provider-lane point:
  - provider-lane enqueue in `runEmbeddedPiAgent` (`src/agents/pi-embedded-runner/run.ts`)
- proof status:
  - INDIRECT
- duplicate-hook risk:
  - POSSIBLE
- coverage conclusion:
  - PARTIAL

Unproven remainder:

- For ACP-ready session keys on this endpoint, provider-lane reachability to `runEmbeddedPiAgent` is not direct/proven because ACP branch can satisfy the request without entering embedded runner.

## 8. Boundary conclusion

- Selected admission boundaries are valid boundary candidates for both paths and are directly on entry flow.
- Selected provider-lane boundary is only directly reached on non-ACP branches.
- Therefore both paths remain partial for provider-lane proof under mixed ACP/non-ACP runtime semantics.
- No direct evidence from this bounded pass shows that a second admission hook is required.

## 9. Mission 10 implication

Mission 10 can proceed, but planning should treat ACP-branch provider-concurrency semantics as an explicit unresolved dependency before claiming full coverage closure for these two paths.

## 10. One bounded next action

Perform one ACP-specific boundary identification pass for these same two paths to determine whether ACP run paths have a distinct provider/admission-equivalent control surface.
