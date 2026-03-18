---
name: blink-clickup
description: >
  Manage ClickUp tasks, lists, and spaces. Use when asked to create tasks, update
  statuses, list projects, or track work items in ClickUp. Requires a linked
  ClickUp connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "clickup" } }
---

# Blink ClickUp

Access the user's linked ClickUp workspace. Provider key: `clickup`.

## Get workspaces (teams)
```bash
bash scripts/call.sh /team GET
```

## Get spaces in a workspace
```bash
bash scripts/call.sh /team/{teamId}/space GET '{"archived":false}'
```

## Get lists in a folder
```bash
bash scripts/call.sh /folder/{folderId}/list GET
```

## Get tasks in a list
```bash
bash scripts/call.sh /list/{listId}/task GET '{"include_closed":false}'
```

## Create a task
```bash
bash scripts/call.sh /list/{listId}/task POST '{"name":"New task","description":"Task details","priority":2}'
```

## Update a task
```bash
bash scripts/call.sh /task/{taskId} PUT '{"status":"in progress","priority":1}'
```

## Get a specific task
```bash
bash scripts/call.sh /task/{taskId} GET
```

## Get tasks assigned to me
```bash
bash scripts/call.sh /team/{teamId}/task GET '{"assignees[]":"{userId}","include_closed":false}'
```

## Common use cases
- "Create a task 'Fix bug' in my dev list" → POST /list/{listId}/task
- "What tasks are in progress?" → GET /list/{listId}/task?statuses[]=in progress
- "Mark task X as done" → PUT /task/{id} with status=complete
- "List all tasks assigned to me" → GET /team/{teamId}/task?assignees[]={me}
- "What's in my ClickUp workspace?" → GET /team → GET /team/{id}/space
