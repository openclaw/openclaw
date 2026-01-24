---
name: manus
description: Create and manage AI agent tasks via Manus API. Manus is an autonomous AI agent that can browse the web, use tools, and deliver complete work products.
homepage: https://manus.im
metadata: {"clawdbot":{"emoji":"🤖","requires":{"env":["MANUS_API_KEY"]},"primaryEnv":"MANUS_API_KEY"}}
---

# Manus AI Agent

Use the Manus API to create autonomous AI tasks. Manus can browse the web, use tools, and deliver complete results (reports, code, presentations, etc.).

## API Base

`https://api.manus.ai/v1`

## Authentication

Header: `API_KEY: <your-key>`

Set via:
- `MANUS_API_KEY` env var
- Or `skills.manus.apiKey` in clawdbot config

## Recommended Workflow

When using Manus for tasks that produce files (slides, reports, etc.):

1. **Create the task** with `createShareableLink: true`
2. **Poll for completion** using the task_id
3. **Extract output files** from the response and download them locally
4. **Deliver to user** via direct file attachment (don't rely on manus.im share links)

## Create a Task

```bash
curl -X POST "https://api.manus.ai/v1/tasks" \
  -H "API_KEY: $MANUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Your task description here",
    "agentProfile": "manus-1.6",
    "taskMode": "agent",
    "createShareableLink": true
  }'
```

Response:
```json
{
  "task_id": "abc123",
  "task_title": "Task Title",
  "task_url": "https://manus.im/app/abc123"
}
```

## Agent Profiles

| Profile | Description | Use for |
|---------|-------------|---------|
| `manus-1.6` | Standard (default) | Most tasks |
| `manus-1.6-lite` | Faster, lighter | Quick/simple stuff |
| `manus-1.6-max` | Complex, thorough | Deep research/analysis |

**Default:** Always use `manus-1.6` unless user specifies otherwise.

## Task Modes

| Mode | Description |
|------|-------------|
| `chat` | Conversational mode |
| `adaptive` | Auto-selects best approach |
| `agent` | Full autonomous agent mode (recommended for file creation) |

## Get Task Status & Output

```bash
curl "https://api.manus.ai/v1/tasks/{task_id}" \
  -H "API_KEY: $MANUS_API_KEY"
```

Status values: `pending`, `running`, `completed`, `failed`

**Important:** When status is `completed`, check the `output` array for files:
- Look for `type: "output_file"` entries
- Download files from `fileUrl` directly
- Save locally and send to user as attachments

## Extracting Output Files

The task response includes output like:
```json
{
  "output": [
    {
      "content": [
        {
          "type": "output_file",
          "fileUrl": "https://private-us-east-1.manuscdn.com/...",
          "fileName": "presentation.pdf"
        }
      ]
    }
  ]
}
```

Download these files with curl and deliver directly to the user rather than relying on share URLs.

## List Tasks

```bash
curl "https://api.manus.ai/v1/tasks" \
  -H "API_KEY: $MANUS_API_KEY"
```

## Best Practices

1. **Always poll for completion** before telling user the task is done
2. **Download output files locally** instead of giving manus.im links (they can be unreliable)
3. **Use `agent` mode** for tasks that create files/documents
4. **Set reasonable expectations** — Manus tasks can take 2-10+ minutes for complex work

## Docs

- API Reference: https://open.manus.ai/docs
- Main Docs: https://manus.im/docs
