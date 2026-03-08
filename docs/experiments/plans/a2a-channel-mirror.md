---
summary: "Mirror A2A inter-agent communication to a channel for user observability"
read_when:
  - Adding A2A transparency or observability features
  - Reviewing multi-agent communication architecture
owner: "roinheart"
status: "draft"
last_updated: "2026-03-05"
title: "A2A Channel Mirror"
---

# A2A Channel Mirror

## Overview

This spec proposes a new config option that mirrors Agent-to-Agent (A2A) communication to a designated channel. Both the calling agent's outbound request and the called agent's final response are mirrored, making the full inter-agent conversation visible to users in the channel.

This feature is specifically designed for channels that do not support native bot-to-bot messaging (e.g. Feishu). On such channels, A2A is the only way for agents to collaborate, but the collaboration is entirely invisible to users.

## Motivation

OpenClaw supports multi-agent collaboration via A2A sessions. A common deployment pattern on channels like Feishu is:

- Multiple agents, each bound to their own bot account (e.g. product bot, architect bot, fullstack bot).
- Feishu does not support native bot-to-bot messaging, so agents communicate via A2A sessions rather than through the channel.
- Each agent produces a response privately back to the calling agent. The calling agent has full context, but **users see none of this exchange in the group chat**.

This creates a black-box experience for users. When a user triggers a multi-agent workflow, they see only the final reply from the coordinator agent. All intermediate delegation, reasoning, and sub-agent responses are invisible.

This feature addresses two problems:

**1. Visibility: A2A communication is a black box to users.**
The goal is to make the full A2A conversation visible by optionally mirroring both sides of the exchange to a specified channel. Because each agent already has its own bot identity on the channel, mirrored messages appear as natural posts from their respective bots — no special formatting or attribution is needed. The result looks like multiple bots genuinely conversing in the group.

**2. Context continuity: A2A sessions and channel sessions are isolated.**
When Agent A calls Agent B via `sessions_send`, the conversation is recorded in Agent B's main session (e.g. `agent:product:main`). However, when a user later @mentions Agent B directly in the channel, that message routes to Agent B's group session (e.g. `agent:product:feishu:group:<chatId>`). These are two separate sessions with no shared history.

This means Agent B has no awareness of its prior A2A exchange when directly addressed by a user — the collaboration context is silently lost.

By mirroring A2A requests and responses into the channel, these messages become part of the group session history. When a user subsequently @mentions Agent B, Agent B can see the prior A2A exchange in its group session context, making cross-session collaboration continuous and coherent.

## Proposed Config

```json5
{
  agents: {
    defaults: {
      a2a: {
        mirror: {
          scope: "none",             // "none" | "request" | "response" | "full"
          target: "feishu",          // channel to mirror to
          chatId: "oc_xxx",          // target group chat id
          onDeliveryFail: "drop",    // "drop" | "retry"
        },
      },
    },
    list: [
      {
        id: "main",
        // coordinator: mirrors outbound requests to sub-agents
        a2a: {
          mirror: {
            scope: "request",
            target: "feishu",
            chatId: "oc_9dd3cc7dea3b2da9b71cc9455c0cafb0",
          },
        },
      },
      {
        id: "product",
        a2a: {
          mirror: {
            scope: "response",
            target: "feishu",
            chatId: "oc_9dd3cc7dea3b2da9b71cc9455c0cafb0",
          },
        },
      },
      {
        id: "architect",
        a2a: {
          mirror: {
            scope: "response",
            target: "feishu",
            chatId: "oc_9dd3cc7dea3b2da9b71cc9455c0cafb0",
          },
        },
      },
      {
        id: "fullstack",
        a2a: {
          mirror: {
            scope: "response",
            target: "feishu",
            chatId: "oc_9dd3cc7dea3b2da9b71cc9455c0cafb0",
          },
        },
      },
      {
        id: "tools",
        // utility agent: output is not meaningful to users
        a2a: {
          mirror: {
            scope: "none",
          },
        },
      },
    ],
  },
}
```

## Field Definitions

### `agents.defaults.a2a.mirror`

Global default for A2A mirroring behavior. All per-agent `a2a.mirror` blocks merge on top of this.

### `agents.list[].a2a.mirror`

Per-agent override. Deep-merges on top of the global default.

#### `target` (string)

The channel to mirror to. Accepts the same values as `heartbeat.target` (e.g. `"feishu"`, `"discord"`, `"slack"`).

#### `chatId` (string, optional)

The specific conversation or group chat to post to. Format is channel-specific (e.g. a Feishu `chat_id`, a Discord channel id). If omitted, falls back to the channel's default delivery target.

#### `scope` (`"none"` | `"request"` | `"response"` | `"full"`)

Controls which side of the A2A exchange is mirrored. This is the primary on/off switch for mirroring.

| Value | Behavior |
|-------|----------|
| `none` | Mirroring disabled for this agent. Used for utility/tool agents whose output is not meaningful to users. |
| `request` | Mirror only the outbound A2A message sent by this agent to a sub-agent. Used on the **calling** agent. |
| `response` | Mirror only the final reply this agent sends back to the caller. Used on the **called** agent. |
| `full` | Mirror both outbound requests and responses. Useful for agents that both delegate and are delegated to. |

Default: `"none"`.

#### `onDeliveryFail` (`"drop"` | `"retry"`)

What to do when a mirror delivery fails.

| Value | Behavior |
|-------|----------|
| `drop` | Silently discard the failed delivery. The A2A flow is unaffected. (default) |
| `retry` | Retry delivery using the standard channel retry policy. May add latency if retries block the delivery queue. |

Default: `"drop"`.

#### `accountId` (string, optional)

The bot account to use for delivery. Defaults to the agent's bound channel account. In standard multi-bot deployments each agent has its own bot, so this default is correct and does not need to be set explicitly.

## Behavior

### What is mirrored

**For `scope: "request"` (calling agent):**
- The message content sent to the sub-agent via `sessions_send` is mirrored to the channel.
- Posted using the calling agent's own bot account.

**For `scope: "response"` (called agent):**
- Only the agent's **final reply** is mirrored. Internal tool calls, intermediate reasoning steps, and partial outputs are not mirrored.
- Posted using the called agent's own bot account.
- If the agent produces no reply (error, timeout), nothing is mirrored.

### Suppressing output for utility agents

Agents whose A2A output is not meaningful to users (e.g. pure tool/utility agents) should set `scope: "none"`. This prevents their responses from cluttering the channel while still participating in the A2A mesh.

### How it appears in the channel

Each agent posts using its own bot identity. No special prefix or label is added. From the user's perspective, they see multiple bots naturally exchanging messages in the group — a complete, readable multi-agent conversation.

Example flow visible in a Feishu group:

```
🧭 管家:   @产品 用户需求如下，请输出 PRD 框架
📦 产品:   @架构 这个需求涉及分布式存储，请评估技术可行性
🧱 架构:   可行，推荐方案 A。存在以下约束：...
📦 产品:   PRD 框架已完成，关键决策已与架构对齐：...
🧭 管家:   @全栈 以下是 PRD 和架构方案，请开始实现
🛠️ 全栈:   @架构 方案 A 中的模块 X 接口定义有歧义，请确认
🧱 架构:   接口定义如下：...
🛠️ 全栈:   实现完成，已按接口规范对齐
🧭 管家:   所有环节已完成，汇总如下：...
```

### Delivery behavior

Mirror delivery is best-effort and async. It does not block the A2A response from being returned to the calling agent. Delivery order within a single exchange is preserved (request before response), but ordering across concurrent exchanges is not guaranteed.

On delivery failure, behavior is controlled by `onDeliveryFail` (default: `drop`).

### Relation to normal channel replies

Mirroring only triggers during A2A-originated runs. Direct inbound channel messages (a user mentioning the bot) follow normal reply behavior and do not trigger mirroring.

### Relation to the existing announce step

The existing A2A announce step allows the called agent to post a message to its target channel after the exchange completes. `a2a.mirror` is independent of announce:

- Announce is agent-controlled (the agent decides what to post in the announce step).
- Mirror is system-controlled (automatic, config-driven, no agent involvement).
- Mirror covers the request side; announce does not.
- Both can be active simultaneously. If both are enabled, the channel will receive the mirrored response and the announce reply as separate messages.

## Scope and Precedence

- `agents.defaults.a2a.mirror` sets the global default.
- `agents.list[].a2a.mirror` deep-merges on top of defaults.
- If no `a2a.mirror` block exists anywhere, mirroring is disabled.

## Implementation Notes

- **Request mirroring**: requires a hook in the `sessions_send` tool path. When an agent calls `sessions_send`, the runner checks `a2a.mirror.enabled` and `scope`. If mirroring is active for requests, the outbound message is enqueued for delivery before the A2A call is dispatched.
- **Response mirroring**: requires a post-reply hook in the A2A session runner. After the called agent produces its final reply, the runner checks the called agent's `a2a.mirror` config and enqueues delivery if enabled.
- Both hooks use the same outbound delivery pipeline as normal channel sends (formatting, rate-limiting, error handling).
- The `accountId` for delivery is resolved from `bindings` for the respective agent unless explicitly overridden.
- Mirror deliveries must be tagged internally (e.g. `mirror: true`) to prevent recursive mirroring.

## Non-Goals

- This feature is not intended for channels that natively support bot-to-bot messaging.
- This spec does not mirror tool calls or intermediate reasoning steps.
- This spec does not add formatting, threading, or attribution to mirrored messages.
- This spec does not change A2A session semantics or the `sessions_send` API contract.
- This spec does not guarantee message ordering across concurrent multi-agent exchanges.

## Open Questions

1. Should `onDeliveryFail: "retry"` use the same retry policy as normal channel sends, or a separate configurable policy?
