---
summary: "Adopt durable inbound events at the ACP prompt submission boundary."
read_when:
  - Changing ACP reply dispatch or durable ingress adoption
title: "ACP ingress adoption"
---

# ADR-001: Adopt ACP turns before prompt submission

## Status

Proposed

## Date

2026-10-10

## Context

Durable channel ingress distinguishes startup from an adopted turn. ACP reply dispatch runs through a plugin hook, so it must carry the existing ingress acknowledgement across that boundary. Without it, the startup watchdog can cancel and replay a healthy long-running review.

The acpx plugin's operation timeout bounds startup and control commands. The ACP manager owns the separate execution deadline; the ingress startup watchdog must stop once the turn is adopted.

## Decision

Add the optional `onTurnAdopted` callback to the existing `reply_dispatch` context. The ACP SDK adapter forwards it to the reply dispatcher, which awaits it at the manager's existing `onBeforePrompt` boundary after durable input and backend preparation, immediately before submitting the prompt.

The host binds the callback to the active dispatch and cancellation signals. ACP acknowledges once across fresh-session retries and rechecks authority after the awaited callback. Rejection prevents backend submission. The existing ingress owner records adoption and clears its startup watchdog; the ACP manager continues to own turn execution deadlines and cancellation.

Keep timeout ownership with the existing ingress, operation, and execution owners. See [message hook documentation](/plugins/hooks/messages) for the public callback contract and [ACP setup](/tools/acp-agents-setup) for timeout ownership.

## Alternatives considered

- Acknowledge when the hook starts: this would stop startup protection before backend readiness and durable input ownership are established.
- Acknowledge from a runtime lifecycle observer: observer failures are swallowed, so failed adoption would not reliably prevent submission.
- Raise the ingress or hook timeout: any finite startup timeout would still interrupt sufficiently long healthy turns and leave competing execution owners.

## Consequences

Existing plugins remain compatible because the callback is optional. Plugins dispatching durable work must await it at their own prepared submission boundary. Calls retained after dispatch completion or cancellation fail.

This changes no queue schema, retention policy, permissions, or execution timeout configuration. Tests cover adoption before runtime effects, reviews exceeding the ingress deadline without replay, expired startup, and explicit cancellation. Live channel validation remains a separate rollout step.
