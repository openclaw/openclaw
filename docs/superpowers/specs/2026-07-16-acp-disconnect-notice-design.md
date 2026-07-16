# ACP Disconnect Notice Design

## Goal

Make a pending ACP prompt that is rejected after the Gateway disconnect grace period visibly and durably terminal, without changing other prompt-rejection behavior.

## Scope

- Change only the grace-expiry rejection path in `src/acp/translator.ts`.
- Use the existing ACP session-update and event-ledger seam.
- Do not add configuration, protocol fields, storage formats, or channel behavior.
- Do not change ordinary `chat.send` errors or structured Gateway error mappings.

## Design

The translator will settle a grace-expired pending prompt through one asynchronous, idempotent helper. It will verify that the pending entry is still current, reserve settlement for its `(sessionId, runId)`, remove its active-run state, emit a recorded `agent_message_chunk`, then reject the original prompt with the existing disconnect error.

The recorded chunk is emitted with the existing `sessionUpdates.emit({ record: true })` contract, preserving the current ACP-client delivery and SQLite-backed replay behavior. If the update transport or ledger write fails, the helper will log the failure and still reject the prompt so an infrastructure failure cannot leave the prompt hanging.

At a disconnect deadline, a missing `chat.send` acknowledgement cannot prove that Gateway did not accept the message: the response may have been lost after acceptance. Every recorded interruption therefore reports an outcome-unknown state and explicitly does not ask for an automatic resend. `PendingPrompt.sendAccepted` still controls reconciliation, but its absence is not delivery proof.

All other rejection paths retain their current behavior. In particular, a known immediate `chat.send` failure remains unrecorded, preventing a prompt that Gateway never accepted from being presented as session history.

## Alternatives Considered

1. Record every `rejectPendingPrompt` call. Rejected: this exceeds the issue scope and records known pre-accept failures.
2. Return a richer JSON-RPC error only. Rejected: the session stream and replay ledger remain silent.
3. Use a new ledger or transcript fallback. Rejected: the existing recorded session-update abstraction owns both delivery and replay, so a second path would duplicate lifecycle policy.

## Error Handling and Idempotency

The settlement helper must keep the existing stale-prompt identity check and settlement-key guard. Concurrent reconnect, grace-timer, or delayed-send paths may therefore neither emit a second notice nor reject a replacement prompt. The original disconnect error remains the rejected promise value.

## Test Plan

Tests will be written before runtime changes and will prove:

1. A grace-expired accepted prompt emits one recorded interruption chunk, rejects with the existing disconnect error, and never recommends a resend.
2. A grace-expired unacknowledged prompt emits one recorded outcome-unknown interruption chunk, rejects with the existing disconnect error, and never recommends a resend.
3. The emitted interruption is present in event-ledger replay after a new ACP agent loads the session.
4. Existing transient reconnect, stale-timer, and direct pre-accept send-failure behavior remains unchanged.

Focused remote validation will run the ACP translator test files and changed checks on Blacksmith Testbox through Crabbox. Before the PR, the branch will receive a structured autoreview and a final diff check.
