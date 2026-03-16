---
title: "OAG Sentinel Schema"
summary: "Field specification for channel-health-state.json produced by the sentinel pipeline"
---

# OAG Sentinel Schema

The sentinel pipeline writes OAG state to `~/.openclaw/sentinel/channel-health-state.json`. OAG reads this file to generate status summaries, recovery notes, and health evaluations.

## Schema Version Detection

OAG detects the schema version from the `schema_version` field:

- **v1** (default): When `schema_version` is absent or `< 2`. Accepts both snake_case and camelCase field names for backward compatibility.
- **v2**: When `schema_version >= 2`. Strict snake_case only.

## v1 Fields (Current Production)

### Top Level

| Field                       | Type     | Required | Description                             |
| --------------------------- | -------- | -------- | --------------------------------------- |
| `congested`                 | boolean  | yes      | Whether delivery pressure is active     |
| `backlogged_after_recovery` | boolean  | no       | Backlog persists after channel recovery |
| `pending_deliveries`        | number   | yes      | Count of queued outbound deliveries     |
| `recent_failure_count`      | number   | yes      | Recent delivery failure count           |
| `backlog_age_minutes`       | number   | no       | How long the backlog has persisted      |
| `escalation_recommended`    | boolean  | no       | Whether operator action is recommended  |
| `recommended_action`        | string   | no       | Suggested operator action               |
| `affected_channels`         | string[] | no       | List of affected channel IDs            |
| `affected_targets`          | object[] | no       | Detailed per-channel/account targets    |
| `verify_attempts`           | number   | no       | Recovery verification attempt count     |
| `last_action`               | string   | no       | Most recent OAG action type             |
| `last_action_at`            | string   | no       | ISO timestamp of last action            |
| `last_action_detail`        | string   | no       | Human-readable last action detail       |
| `last_verify_at`            | string   | no       | ISO timestamp of last verification      |
| `last_restart_at`           | string   | no       | ISO timestamp of last gateway restart   |
| `last_failure_at`           | string   | no       | ISO timestamp of last failure           |
| `last_recovered_at`         | string   | no       | ISO timestamp of last recovery          |
| `updated_at`                | string   | no       | ISO timestamp of last state update      |
| `session_watch`             | object   | no       | Session watchdog state                  |
| `task_watch`                | object   | no       | Task follow-up watch state              |
| `pending_user_notes`        | object[] | no       | Pending OAG user notifications          |
| `delivered_user_notes`      | object[] | no       | Delivered notification audit trail      |

### affected_targets[]

In v1, the parser accepts both snake_case and camelCase variants for backward compatibility:

| Field         | snake_case           | camelCase           | Type     |
| ------------- | -------------------- | ------------------- | -------- |
| Channel ID    | `channel`            | `channel`           | string   |
| Account ID    | `account_id`         | `accountId`         | string   |
| Session keys  | `session_keys`       | `sessionKeys`       | string[] |
| Pending count | `pending_deliveries` | `pendingDeliveries` | number   |
| Failure count | `recent_failures`    | `recentFailures`    | number   |

### session_watch

| Field                    | Type                   | Description                             |
| ------------------------ | ---------------------- | --------------------------------------- |
| `active`                 | boolean                | Whether watchdog is active              |
| `affected_channels`      | string[]               | Channels with stalled sessions          |
| `state_counts`           | Record<string, number> | Count by state (blocked, stalled, etc.) |
| `affected_sessions`      | object[]               | Per-session detail                      |
| `escalation_recommended` | boolean                | Whether escalation is needed            |
| `recommended_action`     | string                 | Suggested action                        |
| `last_action`            | string                 | Last watchdog action                    |
| `last_action_at`         | string                 | Last action timestamp (ISO)             |
| `last_action_detail`     | string                 | Human-readable last action detail       |
| `last_nudge_at`          | string                 | Last nudge timestamp (ISO)              |
| `updated_at`             | string                 | Last update timestamp (ISO)             |

#### affected_sessions[]

| Field                    | Type    | Description                                         |
| ------------------------ | ------- | --------------------------------------------------- |
| `agent_id`               | string  | Agent ID                                            |
| `session_key`            | string  | Session key                                         |
| `session_id`             | string  | Session ID                                          |
| `channel`                | string  | Channel name                                        |
| `account_id`             | string  | Account ID                                          |
| `state`                  | string  | Session state (e.g., blocked, stalled, interrupted) |
| `reason`                 | string  | Reason for the state                                |
| `silent_minutes`         | number  | How long the session has been silent                |
| `blocked_retry_count`    | number  | Retry attempts when blocked                         |
| `escalation_recommended` | boolean | Whether escalation is needed                        |
| `recommended_action`     | string  | Suggested action                                    |

### task_watch

| Field                    | Type                   | Description                  |
| ------------------------ | ---------------------- | ---------------------------- |
| `active`                 | boolean                | Whether task watch is active |
| `counts`                 | Record<string, number> | Count by follow-up type      |
| `escalation_recommended` | boolean                | Whether escalation is needed |
| `recommended_action`     | string                 | Suggested action             |
| `affected_tasks`         | object[]               | Per-task detail              |
| `updated_at`             | string                 | Last update timestamp (ISO)  |

#### affected_tasks[]

| Field                  | Type    | Description                             |
| ---------------------- | ------- | --------------------------------------- |
| `task_id`              | string  | Unique task ID                          |
| `followup_type`        | string  | Type of follow-up (e.g., resume_review) |
| `priority`             | string  | Priority level                          |
| `escalation_count`     | number  | Number of escalations                   |
| `current_step`         | number  | Current step index                      |
| `total_steps`          | number  | Total number of steps                   |
| `step_title`           | string  | Title of the current step               |
| `progress_age_seconds` | number  | How long current step has been running  |
| `terminal_step_stuck`  | boolean | Whether final step is stuck             |
| `deferred_by`          | string  | Who deferred the task                   |
| `not_before`           | string  | ISO timestamp for deferral end          |
| `message`              | string  | Message or status                       |

### pending_user_notes[] and delivered_user_notes[]

| Field        | Type     | Description                                  |
| ------------ | -------- | -------------------------------------------- |
| `id`         | string   | Unique note ID                               |
| `action`     | string   | OAG action type (e.g., `recovery_verify`)    |
| `created_at` | string   | ISO timestamp                                |
| `message`    | string   | Note text (may be localized)                 |
| `targets`    | object[] | Target sessions: `{ sessionKeys: string[] }` |

## v2 Fields (Future)

Same structure as v1 but **strict snake_case only**. When `schema_version >= 2`, the parser reads only snake_case field names. camelCase variants (`accountId`, `sessionKeys`, `pendingDeliveries`, `recentFailures`) are **not** read in v2 mode.

## Example v1 (with mixed naming)

```json
{
  "congested": false,
  "pending_deliveries": 0,
  "recent_failure_count": 0,
  "affected_channels": [],
  "affected_targets": [
    {
      "channel": "telegram",
      "accountId": "default",
      "sessionKeys": ["agent:main:telegram:default:direct:123"],
      "pendingDeliveries": 1
    }
  ],
  "session_watch": {
    "active": true,
    "affected_channels": ["telegram"],
    "affected_sessions": [
      {
        "session_key": "agent:main:telegram:group:-123",
        "channel": "telegram",
        "account_id": "default",
        "state": "interrupted",
        "reason": "network error",
        "silent_minutes": 5
      }
    ]
  },
  "task_watch": {
    "active": true,
    "counts": { "resume_review": 3 },
    "affected_tasks": [
      {
        "task_id": "TASK-001",
        "followup_type": "resume_review",
        "current_step": 2,
        "total_steps": 5,
        "progress_age_seconds": 3600
      }
    ]
  },
  "updated_at": "2026-03-17T00:00:00Z"
}
```

## Example v2 (strict snake_case)

```json
{
  "schema_version": 2,
  "congested": false,
  "pending_deliveries": 0,
  "recent_failure_count": 0,
  "affected_channels": [],
  "affected_targets": [
    {
      "channel": "telegram",
      "account_id": "default",
      "session_keys": ["agent:main:telegram:default:direct:123"],
      "pending_deliveries": 1
    }
  ],
  "session_watch": {
    "active": true,
    "affected_channels": ["telegram"],
    "affected_sessions": [
      {
        "session_key": "agent:main:telegram:group:-123",
        "channel": "telegram",
        "account_id": "default",
        "state": "interrupted",
        "reason": "network error",
        "silent_minutes": 5
      }
    ]
  },
  "task_watch": {
    "active": true,
    "counts": { "resume_review": 3 },
    "affected_tasks": [
      {
        "task_id": "TASK-001",
        "followup_type": "resume_review",
        "current_step": 2,
        "total_steps": 5,
        "progress_age_seconds": 3600
      }
    ]
  },
  "updated_at": "2026-03-17T00:00:00Z"
}
```

## Parsing Rules

The parsing logic in `src/commands/oag-channel-health.ts` enforces these rules:

1. **Schema version detection** (line 92–98):
   - If `schema_version` is a number >= 2, use v2 parsing.
   - Otherwise, default to v1 for backward compatibility.

2. **v1 affected_targets** (line 136–168):
   - Read `account_id` OR `accountId` (v1 accepts both).
   - Read `session_keys` OR `sessionKeys` (v1 accepts both).
   - Read `pending_deliveries` OR `pendingDeliveries` (v1 accepts both).
   - Read `recent_failures` OR `recentFailures` (v1 accepts both).

3. **v2 affected_targets** (line 100–120):
   - Read only `account_id`, `session_keys`, `pending_deliveries`, `recent_failures` (snake_case only).
   - Ignore any camelCase variants.

4. **String trimming**: All string values are trimmed, and empty strings after trimming are treated as absent.

5. **Array filtering**: Arrays filter out null/undefined entries and then check length.
