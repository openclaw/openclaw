# Manus Plugin for OpenClaw

Integration with [Manus AI](https://manus.ai) for async research tasks.

## Features

- **Credit Tracking**: Track Manus task completions and credit usage
- **Budget Awareness**: Alerts when approaching monthly credit limits
- **Auto-Notification**: `manus-watch.py` script polls tasks and wakes the agent on completion
- **Agent Tool**: `manus_track` tool for agents to record task completions

## Configuration

Add to your `openclaw.json` env:

```json
{
  "env": {
    "MANUS_API_KEY": "your-api-key",
    "MANUS_MONTHLY_CREDIT_BUDGET": "500"
  }
}
```

## Gateway Methods

| Method                | Description              |
| --------------------- | ------------------------ |
| `usage.manus.track`   | Record a task completion |
| `usage.manus.summary` | Get usage summary        |
| `usage.manus.budget`  | Get budget context       |

## Agent Tool

```
manus_track(taskId, credits, status?, description?)
```

## Watch Script

Monitor a running task and wake the agent on completion:

```bash
./manus-watch.py <task_id> --interval=60
```

The script polls Manus API and sends a `cron wake` event when the task completes.

## Usage Pattern

1. Agent submits task to Manus API
2. Agent starts `manus-watch.py` in background
3. Agent continues with other work
4. On task completion, watch script wakes the agent
5. Agent retrieves results and tracks credits via `manus_track`
