---
summary: "Design direction for routing exec and plugin approvals to one operator inbox"
read_when:
  - Planning approval routing architecture
  - Setting up one admin approval destination across channels
  - Reviewing approval security and rollout tradeoffs
title: "Approval Admin Terminal"
---

# Approval admin terminal

## Goal

Use one explicit operator destination as the primary approval inbox for OpenClaw, while keeping approval authority fail closed and independent from routing.

Example operator setup:

- Primary admin terminal: Telegram DM (placeholder user id `123456789`)
- Origin channels can include Telegram, Discord, Slack, BlueBubbles, and iMessage

## Desired behavior

- Exec approval requests can be approved from the admin terminal.
- Plugin approval requests can be approved from the same admin terminal.
- Requests from non admin origin channels can still be resolved from the admin terminal.
- Approvals render as clear, chat native approval prompts when available.
- Read only operational commands are pre allowed so prompts focus on high value decisions.

## Design principles

- Delivery target is not approval authority.
- Origin delivery and admin terminal delivery are orthogonal.
- Defaults should be least surprise and least privilege.
- Approval routing must fail closed.
- Approval prompts must preserve provenance context.

## Current baseline in OpenClaw

OpenClaw already has strong primitives for this direction:

- Generic forwarding config exists for exec and plugin under `approvals.exec` and `approvals.plugin`.
- A shared forwarder currently handles both approval kinds.
- Channel native adapters already exist for Telegram, Discord, and Slack.
- The channel runtime already supports native planning, dedupe, and fallback behaviors.

This means the admin terminal model is an evolution of the existing architecture, not a replacement.

## Recommended architecture direction

### 1) Keep generic forwarding as the canonical routing model

Use `approvals.exec` and `approvals.plugin` as the canonical delivery controls.

- `mode: session | targets | both`
- `targets[]` for explicit operator destinations

This should remain the core abstraction for cross channel routing.

### 2) Keep channel native adapters focused on UX and auth

Channel adapters should continue to own:

- Native rendering (buttons/cards)
- Channel specific approver resolution
- Channel specific approval authorization checks

They should not become a second generic routing system.

### 3) Add a thin first class alias only if needed

If user ergonomics are still confusing after cleanup, add a thin alias such as `approvals.adminTerminal` that compiles to existing forwarding config semantics.

Do not create parallel delivery semantics.

## Configuration model

### Current model, recommended now

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "telegram", to: "123456789", accountId: "default" }],
    },
    plugin: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "telegram", to: "123456789", accountId: "default" }],
    },
  },
  channels: {
    telegram: {
      execApprovals: {
        enabled: true,
        approvers: ["123456789"],
        target: "dm",
      },
    },
  },
}
```

### Optional future alias, only if needed

```json5
{
  approvals: {
    adminTerminal: {
      channel: "telegram",
      to: "123456789",
      accountId: "default",
    },
    exec: { enabled: true, mode: "admin-terminal-or-origin" },
    plugin: { enabled: true, mode: "admin-terminal-or-origin" },
  },
}
```

If implemented, this alias should map to the existing forwarding primitives and preserve backward compatibility.

## Safety constraints

- Keep approver checks explicit for each channel.
- Preserve request provenance in forwarded prompts:
  - origin channel
  - source chat or thread
  - source account
  - command or tool preview
  - host and cwd context when applicable
- Do not broaden trust to fix delivery UX.
- Keep timeout and duplicate action protections unchanged.

## Rollout plan

### Phase 1: correctness and drift cleanup

- Align docs and defaults for channel target behavior.
- Clarify origin versus admin terminal semantics.
- Improve actionable fallback text.

### Phase 2: routing precedence and dedupe hardening

- Define precedence between native channel delivery and generic forwarding.
- Prevent duplicate approval prompts when both paths are active.
- Add explicit tests for non Telegram origin to Telegram admin terminal routing.

### Phase 3: approval kind parity

- Keep exec and plugin approval routing semantics aligned.
- Keep authorization semantics aligned unless intentionally documented otherwise.

### Phase 4: optional alias

- Add `approvals.adminTerminal` only if usability still requires it.
- Keep old config valid and migration safe.

## Testing plan

### Unit tests

- Route selection for `session`, `targets`, and `both`
- Account scoped target matching
- Authorization independent from delivery target
- Expired and duplicate decision behavior

### Integration tests

- Origin Telegram to Telegram admin terminal
- Origin Discord or Slack to Telegram admin terminal
- Origin BlueBubbles or iMessage to Telegram admin terminal
- Exec and plugin parity

### Negative tests

- Unauthorized actor in admin terminal chat
- Replayed or stale approval id
- Missing or malformed turn source metadata
- Duplicate delivery path activation

### Manual validation

- Mobile tap flows for allow once, allow always, and deny
- Duplicate tap handling
- Expired button behavior
- Offline and reconnect behavior

## Decisions for this rollout

1. Telegram default approval target is `dm`.
2. Approval authority is approvers only for both exec and plugin approvals.
3. Native channel handling is same channel focused, while cross channel admin terminal routing uses generic forwarding targets.
4. Telegram sends an origin notice when delivery is DM only and the origin target differs from approver DMs.
5. `approvals.adminTerminal` remains optional and deferred unless usability data shows it is still needed after this cleanup.

## Acceptance criteria

Minimum:

- Admin terminal receives clear tappable approval prompts.
- Non admin origin channels can be approved from admin terminal.
- Authorization remains strict and explicit.

Strong:

- No duplicate prompt storms when routing paths overlap.
- Exec and plugin approvals follow one consistent operator model.
- Docs explain setup in one short path without hidden coupling.

## Related docs

- [Exec approvals](/tools/exec-approvals)
- [Telegram](/channels/telegram)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
