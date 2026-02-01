---
summary: "Cron tool for scheduling jobs and reminders via the agent"
read_when:
  - Scheduling reminders or recurring tasks from agent conversations
  - Using the cron tool programmatically
  - Understanding the cron.add job schema
---

# Cron Tool

The `cron` tool lets agents schedule jobs, reminders, and recurring tasks through the Gateway's built-in scheduler.

> **Looking for CLI usage or detailed concepts?** See [Cron Jobs (Gateway Scheduler)](/automation/cron-jobs).

## Quick Reference

| Action | Description | Required Parameters |
|--------|-------------|---------------------|
| `status` | Check cron scheduler status | none |
| `list` | List all jobs | `includeDisabled` (optional) |
| `add` | Create a new job | `job` object (see schema below) |
| `update` | Modify an existing job | `jobId`, `patch` object |
| `remove` | Delete a job | `jobId` |
| `run` | Trigger job immediately | `jobId` |
| `runs` | Get job run history | `jobId` |
| `wake` | Send wake event | `text`, `mode` (optional) |

## Job Schema (for `add` action)

The `job` parameter must be an object with this structure:

```json
{
  "name": "My scheduled task",
  "schedule": { ... },
  "payload": { ... },
  "sessionTarget": "main" | "isolated",
  "wakeMode": "next-heartbeat" | "now",
  "enabled": true,
  "deleteAfterRun": false
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable job name |
| `schedule` | object | When to run (see schedule types below) |
| `payload` | object | What to execute (see payload types below) |
| `sessionTarget` | `"main"` or `"isolated"` | Where to run the job |
| `wakeMode` | `"next-heartbeat"` or `"now"` | When to wake the agent |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether job is active |
| `deleteAfterRun` | boolean | `false` | Remove after successful one-shot |
| `description` | string | — | Optional description |
| `agentId` | string | — | Pin to specific agent (multi-agent setups) |

## Schedule Types

### One-shot (`kind: "at"`)

Run once at a specific time:

```json
{
  "kind": "at",
  "atMs": 1704067200000
}
```

- `atMs`: Unix timestamp in milliseconds

### Interval (`kind: "every"`)

Run at fixed intervals:

```json
{
  "kind": "every",
  "everyMs": 3600000,
  "anchorMs": 1704067200000
}
```

- `everyMs`: Interval in milliseconds (required)
- `anchorMs`: Optional start time anchor

### Cron expression (`kind: "cron"`)

Run on a cron schedule:

```json
{
  "kind": "cron",
  "expr": "0 9 * * 1-5",
  "tz": "America/New_York"
}
```

- `expr`: 5-field cron expression (required)
- `tz`: IANA timezone (optional, defaults to host timezone)

## Payload Types

### System Event (`kind: "systemEvent"`)

**Required for `sessionTarget: "main"`**

Injects a message as a system event:

```json
{
  "kind": "systemEvent",
  "text": "Reminder: Check your calendar for today's meetings."
}
```

### Agent Turn (`kind: "agentTurn"`)

**Required for `sessionTarget: "isolated"`**

Runs a dedicated agent turn:

```json
{
  "kind": "agentTurn",
  "message": "Summarize inbox and send to WhatsApp",
  "deliver": true,
  "channel": "whatsapp",
  "to": "+15551234567"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Prompt for the agent (required) |
| `model` | string | Optional model override |
| `thinking` | string | Thinking level (`off`, `minimal`, `low`, `medium`, `high`) |
| `timeoutSeconds` | number | Optional timeout |
| `deliver` | boolean | Send output to channel |
| `channel` | string | Target channel (`whatsapp`, `telegram`, `discord`, `slack`, `last`) |
| `to` | string | Channel-specific recipient |
| `bestEffortDeliver` | boolean | Don't fail job if delivery fails |

## Critical Constraints

| Session Target | Required Payload Kind |
|----------------|----------------------|
| `main` | `systemEvent` |
| `isolated` | `agentTurn` |

Mismatched combinations will fail validation.

## Examples

### One-shot reminder (main session)

```json
{
  "action": "add",
  "job": {
    "name": "Expense report reminder",
    "schedule": {
      "kind": "at",
      "atMs": 1704067200000
    },
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": {
      "kind": "systemEvent",
      "text": "Reminder: Submit your expense report by end of day."
    },
    "deleteAfterRun": true
  }
}
```

### Daily summary (isolated, deliver to Telegram)

```json
{
  "action": "add",
  "job": {
    "name": "Morning briefing",
    "schedule": {
      "kind": "cron",
      "expr": "0 8 * * *",
      "tz": "America/Los_Angeles"
    },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
      "kind": "agentTurn",
      "message": "Summarize my calendar and top 3 emails for today.",
      "deliver": true,
      "channel": "telegram",
      "to": "123456789"
    }
  }
}
```

### Recurring check (main session, next heartbeat)

```json
{
  "action": "add",
  "job": {
    "name": "Hourly status check",
    "schedule": {
      "kind": "every",
      "everyMs": 3600000
    },
    "sessionTarget": "main",
    "wakeMode": "next-heartbeat",
    "payload": {
      "kind": "systemEvent",
      "text": "Hourly check: Review any pending tasks."
    }
  }
}
```

### Schedule a social media post

```json
{
  "action": "add",
  "job": {
    "name": "Evening X post",
    "schedule": {
      "kind": "at",
      "atMs": 1704139200000
    },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
      "kind": "agentTurn",
      "message": "Post to X: 'Good evening! Here's today's productivity tip: Break large tasks into smaller chunks. #productivity'",
      "deliver": false
    },
    "deleteAfterRun": true
  }
}
```

## Other Actions

### List jobs

```json
{
  "action": "list",
  "includeDisabled": true
}
```

### Update a job

```json
{
  "action": "update",
  "jobId": "abc123",
  "patch": {
    "enabled": false
  }
}
```

### Remove a job

```json
{
  "action": "remove",
  "jobId": "abc123"
}
```

### Send wake event

```json
{
  "action": "wake",
  "text": "Check for new messages",
  "mode": "now"
}
```

## Context Messages

When creating reminders, you can include recent conversation context:

```json
{
  "action": "add",
  "contextMessages": 5,
  "job": { ... }
}
```

This appends the last N messages (up to 10) to system event text for context.

## Related

- [Cron Jobs (Gateway Scheduler)](/automation/cron-jobs) — full conceptual guide
- [Heartbeat](/gateway/heartbeat) — main session scheduling
- [Tools Overview](/tools/index) — all available tools
