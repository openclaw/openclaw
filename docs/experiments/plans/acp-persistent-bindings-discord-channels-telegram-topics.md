# ACP Persistent Bindings for Discord Channels and Telegram Topics

Status: Draft

## Summary

Introduce persistent ACP bindings that map:

- Discord channels (and existing threads, where needed), and
- Telegram topics (`chatId:topic:topicId`)

to long-lived ACP sessions, with binding state stored in `openclaw.json` alongside each channel/topic node.

This makes ACP usage in high-traffic messaging channels predictable and durable, so users can create dedicated channels/topics such as `codex`, `claude-1`, or `claude-myrepo`.

## Why

Current thread-bound ACP behavior is optimized for ephemeral Discord thread workflows. Telegram does not have the same thread model; it has forum topics and DM topics. Users want stable, always-on ACP “workspaces” in chat surfaces, not only temporary thread sessions.

## Goals

- Support durable ACP binding for:
  - Discord channels/threads
  - Telegram forum topics and DM topics
- Make binding source-of-truth config-driven.
- Keep `/acp`, `/new`, `/reset`, `/focus`, and delivery behavior consistent across Discord and Telegram.
- Preserve existing temporary binding flows for ad-hoc usage.

## Non-Goals

- Full redesign of ACP runtime/session internals.
- Removing existing ephemeral binding flows.
- Expanding to every channel in the first iteration.

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
- In bound conversations, `/new` and `/reset` should preserve the binding contract:
  - either reset the bound ACP session in place, or
  - recreate and rebind transparently.

### 3) Conversation identity

- Use canonical conversation IDs:
  - Discord: channel/thread ID.
  - Telegram topic: `chatId:topic:topicId`.
- Never key Telegram bindings by bare topic ID alone.

## Config Model (Proposed)

Use channel-local binding config under existing channel structures (`channels.discord.*`, `channels.telegram.*`), so we do not duplicate channel identity fields.

```jsonc
{
  "channels": {
    "discord": {
      "guilds": {
        "1459246755253325866": {
          "channels": {
            "1469712721581703329": {
              "enabled": true,
              "requireMention": false,
              "bindings": {
                "acp": {
                  "enabled": true,
                  "agentId": "codex",
                  "label": "codex-main",
                  "mode": "persistent",
                  "cwd": "/workspace/repo-a",
                  "backend": "acpx",
                },
              },
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
              "bindings": {
                "acp": {
                  "enabled": true,
                  "agentId": "claude",
                  "label": "claude-repo-b",
                  "mode": "persistent",
                  "cwd": "/workspace/repo-b",
                  "backend": "acpx",
                },
              },
            },
          },
        },
      },
      "direct": {
        "123456789": {
          "topics": {
            "99": {
              "bindings": {
                "acp": {
                  "enabled": true,
                  "agentId": "codex",
                  "mode": "persistent",
                },
              },
            },
          },
        },
      },
    },
  },
}
```

Notes:

- `bindings.acp.backend` is optional. When omitted, fallback to global `acp.backend`.
- Keep existing `session.threadBindings.*` and `channels.discord.threadBindings.*` for temporary binding policies.
- Persistent entries declare desired state; runtime reconciles to actual ACP sessions/bindings.
- One active ACP binding per conversation node is the intended model.

### Backend Selection

- ACP session initialization already uses configured backend selection during spawn (`acp.backend` today).
- This proposal extends spawn/reconcile logic to prefer `bindings.acp.backend` for that conversation when present.
- If no per-conversation backend is set, keep current behavior (`acp.backend` default).

## Architecture Fit in Current System

### Reuse existing components

- `SessionBindingService` already supports channel-agnostic conversation references.
- ACP spawn/bind flows already support binding through service APIs.
- Telegram already carries topic/thread context via `MessageThreadId` and `chatId`.

### New/extended components

- **Telegram binding adapter** (parallel to Discord adapter):
  - register adapter per Telegram account,
  - resolve/list/bind/unbind/touch by canonical conversation ID.
- **Channel-local binding readers**:
  - read Discord `guilds.*.channels.*.bindings.acp`,
  - read Telegram `groups.*.topics.*.bindings.acp` and `direct.*.topics.*.bindings.acp`,
  - normalize into runtime binding intents.
- **Inbound binding resolution for Telegram**:
  - resolve bound session before route finalization (Discord already does this).
- **Persistent binding reconciler**:
  - on startup: load configured channel/topic bindings, ensure ACP sessions exist, ensure bindings exist.
  - on config change: apply deltas safely.

## Phased Delivery

### Phase 1: Persistent model + Discord channels

- Add config schema + validation for Discord channel-local `bindings.acp`.
- Add reconciler that creates/updates persistent Discord bindings.
- Add `/acp bind --persist` and `/acp unbind --persist` for Discord.

### Phase 2: Telegram topic bindings

- Implement Telegram binding adapter and inbound bound-session override.
- Add schema + validation for Telegram topic-local `bindings.acp` in:
  - forum topics (`channels.telegram.groups.<chatId>.topics.<topicId>`)
  - DM topics (`channels.telegram.direct.<chatId>.topics.<topicId>`)

### Phase 3: Command parity and resets

- Align `/acp`, `/new`, `/reset`, and `/focus` behavior in bound Telegram/Discord conversations.
- Ensure binding survives reset flows as configured.

### Phase 4: Hardening

- Better diagnostics (`/acp status`, startup reconciliation logs).
- Conflict handling and health checks.
- Migration helpers for users moving from temporary to persistent binds.

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

- Ship as opt-in per conversation (`bindings.acp.enabled=true`).
- Start with Discord + Telegram only.
- Add docs with examples for:
  - “one channel/topic per agent”
  - “multiple channels/topics per same agent with different `cwd`”
  - “team naming patterns (`codex-1`, `claude-repo-x`)".
