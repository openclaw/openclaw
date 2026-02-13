---
name: convos-channel
description: How to use Convos for E2E encrypted messaging via XMTP
read_when:
  - Working with Convos channel
  - Creating or managing XMTP conversations
  - Inviting users to conversations
  - Understanding Convos architecture
---

# Convos Channel Guide

Convos provides E2E encrypted messaging via XMTP using the `convos` CLI binary. This guide explains how OpenClaw can use Convos to communicate with users.

## Architecture Overview

### CLI-Based Implementation

OpenClaw shells out to the `convos` CLI binary for all XMTP operations:

- One process = one conversation (no pool, no routing)
- Long-lived child processes for streaming and join-request processing
- One-shot commands for send, react, lock, explode, etc.
- Identity management handled by the CLI (`~/.convos/identities/`)

### Owner Channel

When OpenClaw is connected to Convos, there's a special "owner conversation" where you communicate with OpenClaw's operator. This conversation is set during onboarding when the owner pastes an invite link.

The owner conversation ID is stored in `channels.convos.ownerConversationId`.

## Conversation Operations

### Creating New Conversations

Via HTTP route `POST /convos/conversation`:

```json
{ "name": "My Conversation" }
```

Returns `{ conversationId, inviteUrl, inviteSlug }`.

### Joining Conversations

Via HTTP route `POST /convos/join`:

```json
{ "inviteUrl": "https://convos.app/join/<slug>" }
```

### Sending Messages

Via message action `send` with `message` param, or HTTP route `POST /convos/conversation/send`:

```json
{ "message": "Hello!" }
```

### Adding Reactions

Via message action `react` with `messageId` and `emoji` params.

### Locking Conversations

Via HTTP route `POST /convos/lock`:

```json
{ "unlock": false }
```

### Destroying Conversations

Via HTTP route `POST /convos/explode` (irreversible).

## Communication Guidelines

### Owner Channel

The owner conversation (`ownerConversationId`) is your primary communication channel with the operator. Use it for:

- Status updates and notifications
- Requesting approvals for actions
- Reporting errors or issues
- Asking clarifying questions

## Message Targeting

When sending messages via Convos:

- Messages are sent to the single bound conversation
- The conversation ID is set during setup/onboarding
- To send: use action `send` with `message` param

## Error Handling

Common scenarios:

- **Invalid invite**: The invite may be expired or revoked
- **Join pending**: Some joins require approval from the conversation creator
- **Connection issues**: Check network, try `env: "dev"` for testing
- **Instance already bound**: Returns 409 — terminate process and provision a new one

## Configuration Reference

```json
{
  "channels": {
    "convos": {
      "enabled": true,
      "identityId": "cli-managed-id",
      "env": "production",
      "ownerConversationId": "abc123...",
      "dmPolicy": "pairing"
    }
  }
}
```

Key fields:

- `identityId`: CLI-managed identity reference (stored in `~/.convos/identities/`)
- `env`: XMTP environment (production/dev)
- `ownerConversationId`: The conversation for operator communication
- `dmPolicy`: Sender access policy (pairing/allowlist/open/disabled)
