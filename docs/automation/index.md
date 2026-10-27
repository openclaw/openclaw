---
doc-schema-version: 1
summary: "Overview of automation mechanisms: automations, hooks, standing orders, and workflows"
read_when:
  - Deciding how to automate work with OpenClaw
  - Choosing between automations, hooks, and standing orders
  - Looking for the right automation entry point
title: "Automation"
---

OpenClaw runs work in the background through native runtimes, scheduled jobs, event hooks,
and standing instructions. Use this page to pick the right mechanism.

## Quick decision guide

```mermaid
flowchart TD
    START([What do you need?]) --> Q1{Schedule work?}
    START --> Q3{Orchestrate multi-step flows?}
    START --> Q4{React to lifecycle events?}
    START --> Q5{Give the agent persistent instructions?}

    Q1 -->|Yes| CRON["Automations"]

    Q3 -->|Yes| FLOW[Lobster]
    Q4 -->|Yes| HOOKS[Hooks]
    Q5 -->|Yes| SO[Standing Orders]
```

| Use case                                  | Recommended                                | Why                                                    |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Send daily report at 9 AM sharp           | Automations                                | Exact timing, isolated execution                       |
| Remind me in 20 minutes                   | Automations                                | One-shot with precise timing (`--at`)                  |
| Run weekly deep analysis                  | Automations                                | Standalone task, can use different model               |
| Check inbox every 30 min                  | Automations                                | Independent recurring schedule and job history         |
| Trigger safely on new IMAP email          | IMAP plugin                                | Sender-gated isolated reader sessions                  |
| Monitor calendar for upcoming events      | Automations                                | Explicit recurring schedule and delivery policy        |
| Surface ambient main-session updates      | Automations                                | Editable monitoring jobs with quiet results            |
| Run a script on session reset             | Hooks                                      | Internal `HOOK.md` scripts react to lifecycle events   |
| Trigger an agent from an external service | [Webhooks](/automation/cron-jobs#webhooks) | Authenticated HTTP ingress, not an internal event hook |
| Execute code on every tool call           | Plugin hooks                               | Typed `api.on(...)` handlers can intercept tool calls  |
| Always check compliance before replying   | Standing Orders                            | Injected into every session automatically              |

<a id="scheduled-tasks-cron-vs-heartbeat" />

<a id="automations-vs-heartbeat" />

### Periodic monitoring

Recurring reports, reminders, and ambient checks are ordinary automation jobs.
Each job owns its schedule, context, delivery policy, and history. Use
`activeHours` and `idleOnly` when a check should respect quiet hours and foreground
work; use scratch for a small checklist and `NO_REPLY` when nothing needs attention.
Existing heartbeat monitors migrate through [Doctor](/gateway/heartbeat).

## Core concepts

### Automations

Automations are OpenClaw's built-in scheduler for all recurring and one-shot
work, including periodic monitors. The scheduler persists jobs, wakes the agent
at the right time, and can deliver output to a chat channel or webhook endpoint.
It supports one-shot reminders, recurring intervals and cron expressions, and
inbound webhook triggers.

See [Automations](/automation/cron-jobs).

### Background execution and workflows

Use [Sub-agents](/tools/subagents) to launch and wait for delegated runs,
[ACP](/tools/acp-agents) for coding harness sessions, and automation run history
to inspect scheduled work. Each runtime owns execution and completion.

[Lobster](/tools/lobster) runs local pipelines with resumable approvals.
The shared Tasks ledger, TaskFlow orchestration API, and TaskFlow Webhooks plugin
have been removed. Generic [Gateway HTTP hooks](/automation/cron-jobs#webhooks)
remain available for authenticated external triggers.

### Standing orders

Standing orders grant the agent permanent operating authority for defined programs. They live in workspace files (typically `AGENTS.md`) and are injected into every session. Combine with automations for time-based enforcement.

See [Standing Orders](/automation/standing-orders).

### Hooks

Internal hooks are event-driven scripts triggered by agent lifecycle events
(`/new`, `/reset`, `/stop`), session compaction, gateway startup, and message
flow. They are discovered from hook directories and managed with
`openclaw hooks`. For in-process tool-call interception, use
[Plugin hooks](/plugins/hooks).

See [Hooks](/automation/hooks).

### Heartbeat

Existing heartbeat monitors migrate into ordinary editable jobs with their own
scratch, execution policies, and delivery settings. Setup provisions one
proactive check for the ambient owner; later reloads and restarts leave job edits
and deletions alone. See [Heartbeat migration](/gateway/heartbeat).

## How they work together

- **Automations** own recurring reports, reminders, and monitoring checks. Each independently scheduled task belongs in its own job.
- **Hooks** react to specific events (session resets, compaction, message flow) with custom scripts. Plugin hooks cover tool calls.
- **Standing orders** give the agent persistent context and authority boundaries.

## Retired inferred commitments

The inferred commitments experiment was removed in v2026.8.1: OpenClaw no longer
extracts follow-ups from conversations or delivers them through heartbeat.
The `openclaw commitments` maintenance CLI is also gone. The database migration
discards the old commitment rows and removes their table and indexes.

For reminders or scheduled work, create an explicit
[automation](/automation/cron-jobs). Automations are an alternative with a
schedule and instructions you choose; they do not restore inferred follow-ups.

## Related

- [Automations](/automation/cron-jobs) — precise scheduling and one-shot reminders
- [IMAP email trigger](/automation/imap) — sender-gated inbound email and isolated reader sessions
- [MCP Events](/automation/mcp-events) — subscribed events, signed callbacks, and Automation runs
- [Hooks](/automation/hooks) — event-driven lifecycle scripts
- [Plugin hooks](/plugins/hooks) — in-process tool, prompt, message, and lifecycle hooks
- [Standing Orders](/automation/standing-orders) — persistent agent instructions
- [Heartbeat migration](/gateway/heartbeat) — convert periodic monitoring to editable jobs
- [Configuration Reference](/gateway/configuration-reference) — all config keys
