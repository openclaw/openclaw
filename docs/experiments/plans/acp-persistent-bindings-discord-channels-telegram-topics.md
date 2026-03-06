# ACP Persistent Bindings for Discord Channels and Telegram Topics

Status: Draft

## Summary

Introduce persistent ACP bindings that map:

- Discord channels (and existing threads, where needed), and
- Telegram forum topics in groups/supergroups (`chatId:topic:topicId`)

to long-lived ACP sessions, with binding state stored in top-level `bindings[]` entries using explicit binding types.

This makes ACP usage in high-traffic messaging channels predictable and durable, so users can create dedicated channels/topics such as `codex`, `claude-1`, or `claude-myrepo`.

## Why

Current thread-bound ACP behavior is optimized for ephemeral Discord thread workflows. Telegram does not have the same thread model; it has forum topics in groups/supergroups. Users want stable, always-on ACP “workspaces” in chat surfaces, not only temporary thread sessions.

## Goals

- Support durable ACP binding for:
  - Discord channels/threads
  - Telegram forum topics (groups/supergroups)
- Make binding source-of-truth config-driven.
- Keep `/acp`, `/new`, `/reset`, `/focus`, and delivery behavior consistent across Discord and Telegram.
- Preserve existing temporary binding flows for ad-hoc usage.

## Non-Goals

- Full redesign of ACP runtime/session internals.
- Removing existing ephemeral binding flows.
- Expanding to every channel in the first iteration.
- Implementing Telegram channel direct-messages topics (`direct_messages_topic_id`) in this phase.
- Implementing Telegram private-chat topic variants in this phase.

## UX Direction

### 1) Two binding types

- **Persistent binding**: saved in config, reconciled on startup, intended for “named workspace” channels/topics.
- **Temporary binding**: runtime-only, expires by idle/max-age policy.

### 2) Command behavior

- `/acp spawn ... --thread here|auto|off` remains available.
- Add explicit bind lifecycle controls:
  - `/acp bind [session|agent] [--persist]`
  - `/acp unbind [--persist]`
  - `/acp status` includes whether binding is `persistent` or `temporary`.
- In bound conversations, `/new` and `/reset` reset the bound ACP session in place and keep the binding attached.

### 3) Conversation identity

- Use canonical conversation IDs:
  - Discord: channel/thread ID.
  - Telegram topic: `chatId:topic:topicId`.
- Never key Telegram bindings by bare topic ID alone.

## Config Model (Proposed)

Unify routing and persistent ACP binding configuration in top-level `bindings[]` with explicit `type` discriminator:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace-main",
        "runtime": { "type": "embedded" },
      },
      {
        "id": "codex",
        "workspace": "~/.openclaw/workspace-codex",
        "runtime": {
          "type": "acp",
          "acp": {
            "agent": "codex",
            "backend": "acpx",
            "mode": "persistent",
            "cwd": "/workspace/repo-a",
          },
        },
      },
      {
        "id": "claude",
        "workspace": "~/.openclaw/workspace-claude",
        "runtime": {
          "type": "acp",
          "acp": {
            "agent": "claude",
            "backend": "acpx",
            "mode": "persistent",
            "cwd": "/workspace/repo-b",
          },
        },
      },
    ],
  },
  "acp": {
    "enabled": true,
    "backend": "acpx",
    "allowedAgents": ["codex", "claude"],
  },
  "bindings": [
    // Route bindings (existing behavior)
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "discord", "accountId": "default" },
    },
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "telegram", "accountId": "default" },
    },
    // Persistent ACP conversation bindings
    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "222222222222222222" },
      },
      "acp": {
        "label": "codex-main",
        "mode": "persistent",
        "cwd": "/workspace/repo-a",
        "backend": "acpx",
      },
    },
    {
      "type": "acp",
      "agentId": "claude",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "333333333333333333" },
      },
      "acp": {
        "label": "claude-repo-b",
        "mode": "persistent",
        "cwd": "/workspace/repo-b",
      },
    },
    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "telegram",
        "accountId": "default",
        "peer": { "kind": "group", "id": "-1001234567890:topic:42" },
      },
      "acp": {
        "label": "tg-codex-42",
        "mode": "persistent",
      },
    },
  ],
  "channels": {
    "discord": {
      "guilds": {
        "111111111111111111": {
          "channels": {
            "222222222222222222": {
              "enabled": true,
              "requireMention": false,
            },
            "333333333333333333": {
              "enabled": true,
              "requireMention": false,
            },
          },
        },
      },
    },
    "telegram": {
      "groups": {
        "-1001234567890": {
          "topics": {
            "42": {
              "requireMention": false,
            },
          },
        },
      },
    },
  },
}
```

### Minimal Example (No Per-Binding ACP Overrides)

```jsonc
{
  "agents": {
    "list": [
      { "id": "main", "default": true, "runtime": { "type": "embedded" } },
      {
        "id": "codex",
        "runtime": {
          "type": "acp",
          "acp": { "agent": "codex", "backend": "acpx", "mode": "persistent" },
        },
      },
      {
        "id": "claude",
        "runtime": {
          "type": "acp",
          "acp": { "agent": "claude", "backend": "acpx", "mode": "persistent" },
        },
      },
    ],
  },
  "acp": { "enabled": true, "backend": "acpx" },
  "bindings": [
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "discord", "accountId": "default" },
    },
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "telegram", "accountId": "default" },
    },

    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "222222222222222222" },
      },
    },
    {
      "type": "acp",
      "agentId": "claude",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "333333333333333333" },
      },
    },
    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "telegram",
        "accountId": "default",
        "peer": { "kind": "group", "id": "-1009876543210:topic:5" },
      },
    },
  ],
}
```

Notes:

- `bindings[].type` is explicit:
  - `route`: normal agent routing.
  - `acp`: persistent ACP harness binding for a matched conversation.
- For `type: "acp"`, `match.peer.id` is the canonical conversation key:
  - Discord channel/thread: raw channel/thread ID.
  - Telegram topic: `chatId:topic:topicId`.
- `bindings[].acp.backend` is optional. Backend fallback order:
  1. `bindings[].acp.backend`
  2. `agents.list[].runtime.acp.backend`
  3. global `acp.backend`
- `mode`, `cwd`, and `label` follow the same override pattern (`binding override -> agent runtime default -> global/default behavior`).
- Keep existing `session.threadBindings.*` and `channels.discord.threadBindings.*` for temporary binding policies.
- Persistent entries declare desired state; runtime reconciles to actual ACP sessions/bindings.
- One active ACP binding per conversation node is the intended model.
- Backward compatibility: missing `type` is interpreted as `route` for legacy entries.

### Backend Selection

- ACP session initialization already uses configured backend selection during spawn (`acp.backend` today).
- This proposal extends spawn/reconcile logic to prefer typed ACP binding overrides:
  - `bindings[].acp.backend` for conversation-local override.
  - `agents.list[].runtime.acp.backend` for per-agent defaults.
- If no override exists, keep current behavior (`acp.backend` default).

## Architecture Fit in Current System

### Reuse existing components

- `SessionBindingService` already supports channel-agnostic conversation references.
- ACP spawn/bind flows already support binding through service APIs.
- Telegram already carries topic/thread context via `MessageThreadId` and `chatId`.

### New/extended components

- **Telegram binding adapter** (parallel to Discord adapter):
  - register adapter per Telegram account,
  - resolve/list/bind/unbind/touch by canonical conversation ID.
- **Typed binding resolver/index**:
  - split `bindings[]` into `route` and `acp` views,
  - keep `resolveAgentRoute` on `route` bindings only,
  - resolve persistent ACP intent from `acp` bindings only.
- **Inbound binding resolution for Telegram**:
  - resolve bound session before route finalization (Discord already does this).
- **Persistent binding reconciler**:
  - on startup: load configured top-level `type: "acp"` bindings, ensure ACP sessions exist, ensure bindings exist.
  - on config change: apply deltas safely.
- **Cutover model**:
  - no channel-local ACP binding fallback is read,
  - persistent ACP bindings are sourced only from top-level `bindings[].type="acp"` entries.

## Phased Delivery

### Phase 1: Typed binding schema foundation

- Extend config schema to support `bindings[].type` discriminator:
  - `route`,
  - `acp` with optional `acp` override object (`mode`, `backend`, `cwd`, `label`).
- Extend agent schema with runtime descriptor to mark ACP-native agents (`agents.list[].runtime.type`).
- Add parser/indexer split for route vs ACP bindings.

### Phase 2: Runtime resolution + Discord/Telegram parity

- Resolve persistent ACP bindings from top-level `type: "acp"` entries for:
  - Discord channels/threads,
  - Telegram forum topics (`chatId:topic:topicId` canonical IDs).
- Implement Telegram binding adapter and inbound bound-session override parity with Discord.
- Do not include Telegram direct/private topic variants in this phase.

### Phase 3: Command parity and resets

- Align `/acp`, `/new`, `/reset`, and `/focus` behavior in bound Telegram/Discord conversations.
- Ensure binding survives reset flows as configured.

### Phase 4: Hardening

- Better diagnostics (`/acp status`, startup reconciliation logs).
- Conflict handling and health checks.

## Guardrails and Policy

- Respect ACP enablement and sandbox restrictions exactly as today.
- Keep explicit account scoping (`accountId`) to avoid cross-account bleed.
- Fail closed on ambiguous routing.
- Keep mention/access policy behavior explicit per channel config.

## Testing Plan

- Unit:
  - conversation ID normalization (especially Telegram topic IDs),
  - reconciler create/update/delete paths,
  - `/acp bind --persist` and unbind flows.
- Integration:
  - inbound Telegram topic -> bound ACP session resolution,
  - inbound Discord channel/thread -> persistent binding precedence.
- Regression:
  - temporary bindings continue to work,
  - unbound channels/topics keep current routing behavior.

## Open Questions

- Should `/acp spawn --thread auto` in Telegram topic default to `here`?
- Should persistent bindings always bypass mention-gating in bound conversations, or require explicit `requireMention=false`?
- Should `/focus` gain `--persist` as an alias for `/acp bind --persist`?

## Rollout

- Ship as opt-in per conversation (`bindings[].type="acp"` entry present).
- Start with Discord + Telegram only.
- Add docs with examples for:
  - “one channel/topic per agent”
  - “multiple channels/topics per same agent with different `cwd`”
  - “team naming patterns (`codex-1`, `claude-repo-x`)".
