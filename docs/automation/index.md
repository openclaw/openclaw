---
summary: "Overview of all automation mechanisms: heartbeat, cron, tasks, hooks, webhooks, and more"
read_when:
  - Deciding how to automate work with OpenClaw
  - Choosing between heartbeat, cron, hooks, and webhooks
  - Looking for the right automation entry point
title: "Automation Overview"
---

# Automation

OpenClaw provides several automation mechanisms, each suited to different use cases. This page helps you choose the right one.

## Quick decision guide

```mermaid
flowchart TD
    A[What do you need?] --> B{Run on a schedule?}
    A --> C{React to an event?}
    A --> D{Receive external HTTP?}
    A --> E{Persistent instructions?}

    B -->|Yes| F{Exact timing critical?}
    F -->|Yes| G["**Cron** (isolated)"]
    F -->|No| H{Can batch with other checks?}
    H -->|Yes| I[**Heartbeat**]
    H -->|No| J[**Cron**]

    C -->|Yes| K[**Hooks**]
    D -->|Yes| L[**Webhooks**]
    E -->|Yes| M[**Standing Orders**]

    G --> N[All background work tracked via **Tasks**]
    J --> N

    click I "/gateway/heartbeat"
    click G "/automation/cron-jobs"
    click J "/automation/cron-jobs"
    click K "/automation/hooks"
    click L "/automation/webhook"
    click M "/automation/standing-orders"
    click N "/automation/tasks"
```

## Mechanisms at a glance

| Mechanism | What it does | Runs in | Creates task record |
|---|---|---|---|
| [Heartbeat](/gateway/heartbeat) | Periodic main-session turn — batches multiple checks | Main session | No |
| [Cron](/automation/cron-jobs) | Scheduled jobs with precise timing | Main or isolated session | Yes (all types) |
| [Background Tasks](/automation/tasks) | Tracks detached work (cron, ACP, subagents, CLI) | N/A (ledger) | N/A |
| [Hooks](/automation/hooks) | Event-driven scripts triggered by agent lifecycle events | Hook runner | No |
| [Standing Orders](/automation/standing-orders) | Persistent instructions injected into the system prompt | Main session | No |
| [Webhooks](/automation/webhook) | Receive inbound HTTP events and route to the agent | Gateway HTTP | No |

### Specialized automation

| Mechanism | What it does |
|---|---|
| [Gmail PubSub](/automation/gmail-pubsub) | Real-time Gmail notifications via Google PubSub |
| [Polling](/automation/poll) | Periodic data source checks (RSS, APIs, etc.) |
| [Auth Monitoring](/automation/auth-monitoring) | Credential health and expiry alerts |

## How they work together

The most effective setups combine multiple mechanisms:

1. **Heartbeat** handles routine monitoring (inbox, calendar, notifications) in one batched turn every 30 minutes.
2. **Cron** handles precise schedules (daily reports, weekly reviews) and one-shot reminders.
3. **Hooks** react to specific events (tool calls, session resets, compaction) with custom scripts.
4. **Standing Orders** give the agent persistent context ("always check the project board before replying").
5. **Background Tasks** automatically track all detached work so you can inspect and audit it.

See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for a detailed comparison of the two scheduling mechanisms.

## Related

- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — detailed comparison guide
- [Troubleshooting](/automation/troubleshooting) — debugging automation issues
- [Configuration Reference](/gateway/configuration-reference) — all config keys
