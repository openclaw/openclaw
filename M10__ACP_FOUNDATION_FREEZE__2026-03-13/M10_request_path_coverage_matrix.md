# Mission 10 — No-Code Request-Path Coverage Matrix

## 1. Title

Mission 10 request-path coverage matrix for admission and provider-lane insertion boundaries.

## 2. Scope

Strict scope (only):

- active gateway/request entry paths relevant to runtime execution flow
- exactly one chosen admission insertion point per path
- exactly one chosen provider-lane insertion point per path

No source/runtime changes are proposed.

## 3. VERIFIED

- HTTP entry routing in `src/gateway/server-http.ts` invokes:
  - `handleToolsInvokeHttpRequest` for `/tools/invoke`
  - `handleOpenResponsesHttpRequest` for `/v1/responses`
  - `handleOpenAiHttpRequest` for `/v1/chat/completions`
- WS gateway request handling in `src/gateway/server/ws-connection/message-handler.ts` invokes `handleGatewayRequest`.
- `handleGatewayRequest` dispatches method handlers through `coreGatewayHandlers` in `src/gateway/server-methods.ts`.
- `agent` method path in `src/gateway/server-methods/agent.ts` directly calls `agentCommand`.
- OpenResponses path in `src/gateway/openresponses-http.ts` executes via `governorExecute` around `runResponsesAgentCommand` -> `agentCommand`.
- OpenAI-compat path in `src/gateway/openai-http.ts` directly calls `agentCommand` (non-stream and stream paths).
- Provider-lane concurrency setup/reload is applied in:
  - `src/gateway/server-lanes.ts` (`applyGatewayLaneConcurrency`)
  - `src/gateway/server-reload-handlers.ts` (reload lane block)
- Provider-lane enqueue behavior exists in `src/agents/pi-embedded-runner/run.ts` (`runEmbeddedPiAgent` provider lane).

## 4. LIKELY

- `chat.send` path (via `dispatchInboundMessage`) reaches embedded runtime execution paths that use provider-lane enqueue, but this is indirect and not proven in this step with a single direct callsite chain.
- A single admission boundary at `handleGatewayRequest` is likely sufficient for WS JSON-RPC methods, while HTTP endpoints require their own explicit boundary choices.
- Duplicate-hook risk is highest if admission checks are applied both at `handleGatewayRequest` and per-method handlers for the same method family.

## 5. UNKNOWN

- Whether all plugin-defined or extension-defined gateway methods that can trigger agent execution are fully represented by the inspected core paths.
- Whether `/tools/invoke` should participate in provider-lane concurrency at all (may be orthogonal to model-run lanes).
- Whether one provider-lane insertion boundary is semantically sufficient for every execution mode (RPC, OpenResponses, OpenAI-compat, and chat dispatch internals).

## 6. Coverage matrix

| request path / entry surface                   | primary handler/function                                               | chosen admission insertion point                                                  | chosen provider-lane insertion point                                                | confidence | conflict note | gap status |
| ---------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ------------- | ---------- |
| WS RPC (all methods) via gateway socket frames | `handleGatewayRequest` (`src/gateway/server-methods.ts`)               | `handleGatewayRequest`                                                            | `applyGatewayLaneConcurrency` (`src/gateway/server-lanes.ts`)                       | HIGH       | POSSIBLE      | COVERED    |
| WS RPC method `agent`                          | `agentHandlers["agent"]` (`src/gateway/server-methods/agent.ts`)       | `handleGatewayRequest`                                                            | `runEmbeddedPiAgent` provider-lane enqueue (`src/agents/pi-embedded-runner/run.ts`) | HIGH       | POSSIBLE      | COVERED    |
| WS RPC method `chat.send`                      | `chatHandlers["chat.send"]` -> `dispatchInboundMessage`                | `handleGatewayRequest`                                                            | `runEmbeddedPiAgent` provider-lane enqueue (`src/agents/pi-embedded-runner/run.ts`) | MEDIUM     | POSSIBLE      | PARTIAL    |
| HTTP `POST /v1/responses`                      | `handleOpenResponsesHttpRequest` (`src/gateway/openresponses-http.ts`) | `runResponsesAgentCommand` boundary (inside existing `governorExecute` call path) | `runEmbeddedPiAgent` provider-lane enqueue (`src/agents/pi-embedded-runner/run.ts`) | HIGH       | NONE          | COVERED    |
| HTTP `POST /v1/chat/completions`               | `handleOpenAiHttpRequest` (`src/gateway/openai-http.ts`)               | `handleOpenAiHttpRequest` (around `agentCommand` invocation)                      | `runEmbeddedPiAgent` provider-lane enqueue (`src/agents/pi-embedded-runner/run.ts`) | MEDIUM     | POSSIBLE      | PARTIAL    |
| HTTP `POST /tools/invoke`                      | `handleToolsInvokeHttpRequest` (`src/gateway/tools-invoke-http.ts`)    | `handleToolsInvokeHttpRequest`                                                    | `applyGatewayLaneConcurrency` (`src/gateway/server-lanes.ts`)                       | LOW        | POSSIBLE      | UNKNOWN    |

## 7. Path gaps or conflicts

- Duplicate-hook risk (POSSIBLE): WS paths if admission controls are added at both `handleGatewayRequest` and method-local handlers (`agentHandlers`/`chatHandlers`).
- Gap (PARTIAL): `chat.send` path has indirect execution flow through `dispatchInboundMessage`; provider-lane coverage is inferred, not fully proven by a direct chain in this step.
- Gap (PARTIAL): `/v1/chat/completions` has direct `agentCommand` calls but no verified existing governor wrapper at this endpoint, so admission boundary is chosen but not yet validated as semantically aligned with OpenResponses.
- Gap (UNKNOWN): `/tools/invoke` relation to provider-lane concurrency remains uncertain and may not belong to this lane model.

## 8. Mission 10 implication

Coverage is strong enough to continue bounded planning, but there are still partial/unknown paths that need one focused validation pass before implementation planning can claim full boundary safety.

## 9. One bounded next action

Run a single call-chain proof pass for `chat.send` and `/v1/chat/completions` to verify end-to-end execution reaches the selected provider-lane boundary without requiring a second admission hook.
