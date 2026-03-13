# Mission 10 — ACP-Side Boundary Identification

## 1. Title

Mission 10 bounded ACP-side boundary identification for remaining partial paths.

## 2. Scope

Strict scope (only):

- WS `chat.send` ACP branch
- HTTP `POST /v1/chat/completions` ACP branch

Goal: identify ACP-side admission-equivalent and provider/concurrency-equivalent control surfaces corresponding to non-ACP provider-lane flow.

## 3. VERIFIED

- ACP policy gates are explicitly checked before ACP turn execution:
  - `resolveAcpDispatchPolicyError(...)`
  - `resolveAcpAgentPolicyError(...)`
    in:
  - `src/auto-reply/reply/dispatch-acp.ts`
  - `src/commands/agent.ts`
- ACP branch gating by session resolution exists:
  - `AcpSessionManager.resolveSession(...)` returns `none` / `stale` / `ready`
  - used in both ACP entry paths.
- ACP turn execution converges on `AcpSessionManager.runTurn(...)` in `src/acp/control-plane/manager.core.ts`.
- `runTurn(...)` is serialized per session by `withSessionActor(...)` which uses `SessionActorQueue` (`src/acp/control-plane/session-actor-queue.ts`).
- ACP manager enforces concurrent ACP runtime session caps via `enforceConcurrentSessionLimit(...)` using `cfg.acp.maxConcurrentSessions` (applied during session initialization / runtime ensure flows).
- Observability reports ACP queue depth and active runtimes (`getObservabilitySnapshot`) and is logged by ACP dispatch path.
- No direct ACP surface was found that mirrors non-ACP provider-specific lane keying (`provider:<id>`).

## 4. LIKELY

- ACP admission-equivalent control is strong and explicit at policy + session-resolution gates before `runTurn(...)`.
- ACP concurrency-equivalent control exists at session actor queue + runtime session cap level.
- ACP provider-specific concurrency equivalence (per-provider throttling) is likely absent or not represented with provider lane semantics in inspected ACP surfaces.

## 5. UNKNOWN

- Whether backend-specific ACP runtimes enforce additional provider/model concurrency controls internally beyond exposed manager surfaces.
- Whether ACP runtime options (for example `model`, `approval_policy`, `timeout`) indirectly satisfy provider-fairness goals in a way equivalent to provider-lane concurrency.

## 6. ACP-side boundary analysis for `chat.send`

- ACP entry branch point:
  - `chat.send` -> `dispatchInboundMessage` -> `dispatchReplyFromConfig` -> `tryDispatchAcpReply(...)` when ACP session resolves and command bypass is false.
- candidate admission-equivalent surface:
  - primary: `resolveAcpDispatchPolicyError(...)`, `resolveAcpAgentPolicyError(...)`, stale-session rejection in `tryDispatchAcpReply(...)` before `acpManager.runTurn(...)`.
  - fallback: `AcpSessionManager.runTurn(...)` rejects `none`/`stale` session states.
- candidate concurrency/provider-equivalent surface:
  - primary (concurrency): per-session serialization via `SessionActorQueue` through `withSessionActor(...)` in manager `runTurn(...)`.
  - fallback (concurrency): ACP runtime/session cap via `enforceConcurrentSessionLimit(...)`.
  - provider-equivalent: no direct ACP provider-lane equivalent proven.
- proof status:
  - admission-equivalent: DIRECT
  - concurrency-equivalent: DIRECT (session-level), provider-equivalent: NOT PROVEN
- confidence:
  - admission-equivalent: HIGH
  - concurrency-equivalent: HIGH
  - provider-equivalent: LOW
- risk note:
  - ACP path can bypass provider-lane semantics; if provider fairness depends on `provider:<id>` lanes, ACP behavior may diverge.
- candidate appears:
  - admission-equivalent: primary
  - concurrency-equivalent: primary
  - provider-equivalent: unknown

## 7. ACP-side boundary analysis for `/v1/chat/completions`

- ACP entry branch point:
  - `/v1/chat/completions` -> `handleOpenAiHttpRequest` -> `agentCommand` -> ACP branch when `acpResolution.kind === "ready"`.
- candidate admission-equivalent surface:
  - primary: `resolveAcpDispatchPolicyError(...)` + `resolveAcpAgentPolicyError(...)` + ACP stale-session handling in `agentCommand` ACP branch.
  - fallback: manager `runTurn(...)` session-state validation.
- candidate concurrency/provider-equivalent surface:
  - primary (concurrency): manager `runTurn(...)` serialized by session actor queue.
  - fallback (concurrency): ACP runtime/session cap enforcement.
  - provider-equivalent: no direct ACP per-provider lane/concurrency surface proven.
- proof status:
  - admission-equivalent: DIRECT
  - concurrency-equivalent: DIRECT (session-level), provider-equivalent: NOT PROVEN
- confidence:
  - admission-equivalent: HIGH
  - concurrency-equivalent: HIGH
  - provider-equivalent: LOW
- risk note:
  - endpoint can execute through ACP without touching non-ACP provider lanes; provider-specific throttling parity remains unverified.
- candidate appears:
  - admission-equivalent: primary
  - concurrency-equivalent: primary
  - provider-equivalent: unknown

## 8. Boundary comparison

- non-ACP boundary:
  - `runEmbeddedPiAgent` provider lane enqueue (`provider:<id>`) for provider-concurrency behavior.
- ACP-side equivalent boundary:
  - admission-equivalent: ACP policy + session-resolution checks before `acpManager.runTurn(...)`.
  - concurrency-equivalent: `SessionActorQueue` serialization + ACP max concurrent session cap.
  - provider-equivalent: no direct `provider:<id>`-style equivalent proven.
- proof status:
  - admission-equivalent: DIRECT
  - concurrency-equivalent (session-level): DIRECT
  - provider-equivalent (provider-level): NOT PROVEN

## 9. Mission 10 implication

Branch-level mapping is now complete for admission and session-level concurrency controls, but provider-specific concurrency equivalence remains unproven on ACP branches. Mission 10 should treat ACP provider-fairness parity as an explicit unresolved item rather than assuming non-ACP lane semantics carry over.

## 10. One bounded next action

Run one bounded ACP runtime-capability check focused on whether active ACP backends expose model/provider-scoped throttling controls that can map to provider-lane intent.
