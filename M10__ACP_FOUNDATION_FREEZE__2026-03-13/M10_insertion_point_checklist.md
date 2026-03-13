# Mission 10 — Bounded Insertion-Point Checklist

## 1. Title

Mission 10 bounded insertion-point checklist for remaining unique features.

## 2. Scope

Strict scope (only):

- provider-lane concurrency
- governor / admission control

This checklist identifies likely minimal attachment points in upstream-aligned code. It does not propose runtime redesign or source edits.

## 3. VERIFIED

- `src/gateway/server-lanes.ts` contains `applyGatewayLaneConcurrency` and currently applies lane concurrency for built-in lanes plus provider lanes via `setCommandLaneConcurrency("provider:<id>", ...)`.
- `src/gateway/server-reload-handlers.ts` reapplies lane concurrency during reload, including provider-lane assignments.
- `src/process/command-queue.ts` exposes `setCommandLaneConcurrency(lane, maxConcurrent)`.
- `src/agents/pi-embedded-runner/run.ts` (`runEmbeddedPiAgent`) resolves session/global lanes and currently derives a provider lane and enqueues through it.
- `src/gateway/openresponses-http.ts` routes request execution through `runResponsesAgentCommand` to `agentCommand`.
- `src/gateway/server-methods.ts` dispatches method handlers through `handleGatewayRequest` and `coreGatewayHandlers`.
- `src/gateway/server-methods/agent.ts` and `src/gateway/server-methods/chat.ts` are active method-level execution surfaces.

## 4. LIKELY

- Provider-lane concurrency can be preserved with minimal risk by centering configuration mapping and reload consistency in gateway lane setup/reload surfaces, while leaving queue internals unchanged.
- Governor/admission control is most safely attached at explicit gateway execution boundaries before `agentCommand` invocation, not by deep queue/runtime rewrites.
- Embedded runner lane behavior is likely a secondary/fallback attachment point unless gateway-level coverage proves insufficient.

## 5. UNKNOWN

- Whether upstream now has hidden or indirect admission controls that already satisfy part of governor intent.
- Whether a single admission gate covers all relevant execution paths (HTTP, JSON-RPC, chat/agent handlers, and embedded paths) without gaps.
- Exact rollback sequence needed if admission controls create latency/backpressure regressions under real load.

## 6. Provider-lane concurrency checklist

- file path: `src/gateway/server-lanes.ts`
- function / surface name: `applyGatewayLaneConcurrency`
- why it is a candidate: primary central lane-concurrency mapping point; already sets provider-lane limits.
- confidence: HIGH
- risk note: config-shape drift can silently mis-map provider IDs.
- appears: primary

- file path: `src/gateway/server-reload-handlers.ts`
- function / surface name: reload concurrency reapplication path (lane-concurrency block)
- why it is a candidate: preserves provider-lane behavior across runtime config reloads; prevents stale limits.
- confidence: HIGH
- risk note: partial reload logic can diverge from startup path if not kept symmetrical.
- appears: primary

- file path: `src/process/command-queue.ts`
- function / surface name: `setCommandLaneConcurrency`
- why it is a candidate: foundational primitive used by gateway lane configuration.
- confidence: MEDIUM
- risk note: touching queue primitives raises blast radius across all lanes.
- appears: fallback

- file path: `src/agents/pi-embedded-runner/run.ts`
- function / surface name: `runEmbeddedPiAgent` provider-lane enqueue path
- why it is a candidate: direct per-run provider-lane selection for embedded execution.
- confidence: MEDIUM
- risk note: runner semantics are Tier-1-sensitive; changes can alter scheduling/fairness unexpectedly.
- appears: fallback

## 7. Governor / admission control checklist

- file path: `src/gateway/openresponses-http.ts`
- function / surface name: `handleOpenResponsesHttpRequest` / `runResponsesAgentCommand`
- why it is a candidate: clear external request-entry path before command execution.
- confidence: HIGH
- risk note: endpoint-specific insertion may miss non-openresponses call paths.
- appears: primary

- file path: `src/gateway/server-methods.ts`
- function / surface name: `handleGatewayRequest`
- why it is a candidate: central request dispatch boundary for core gateway methods.
- confidence: HIGH
- risk note: broad interception can impact latency/error semantics for all methods.
- appears: primary

- file path: `src/gateway/server-methods/agent.ts`
- function / surface name: `agentHandlers` execution paths
- why it is a candidate: direct agent command entry point for method-level admission checks.
- confidence: MEDIUM
- risk note: handler-local gating may duplicate logic or drift from other paths.
- appears: fallback

- file path: `src/gateway/server-methods/chat.ts`
- function / surface name: `chatHandlers` execution paths
- why it is a candidate: may require consistent admission behavior where chat maps to agent execution.
- confidence: LOW
- risk note: uncertain equivalence to agent/run paths; easy to over-constrain user-facing chat flows.
- appears: avoid for now

## 8. Files/functions to avoid touching unless later evidence requires it

- `src/process/command-queue.ts` internals beyond existing public lane primitives (`setCommandLaneConcurrency`, enqueue APIs): avoid for now due cross-lane blast radius.
- `src/agents/pi-embedded-runner/compact.ts` compaction lane flow: avoid for now unless admission coverage gap is proven there.
- `src/agents/pi-embedded-runner/lanes.ts` lane key derivation helpers: avoid for now unless naming/partition collision is demonstrated.
- Broad gateway method fan-out in `src/gateway/server-methods.ts` beyond explicit dispatch boundary insertion: avoid for now to preserve upstream method behavior.

## 9. Mission 10 implication

Mission 10 can stay narrowly scoped by treating gateway lane setup/reload and gateway request-entry boundaries as the minimal primary attachment points. Queue internals and broad runner/refactor work should remain out-of-scope unless later evidence proves coverage gaps.

## 10. One bounded next action

Build a no-code validation matrix that traces each active request path to one selected admission insertion point and one selected lane-concurrency insertion point, then mark uncovered paths explicitly before implementation planning.
