---
name: blink-asana
description: >
  Manage Asana tasks, projects, and workspaces. Use when asked to create tasks,
  update project status, list assignments, or check deadlines. Requires a linked
  Asana connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "asana" } }
---

# Blink Asana

Access the user's linked Asana workspace. Provider key: `asana`.

## List workspaces
```bash
bash scripts/call.sh asana /workspaces GET
```

## Get my tasks
```bash
bash scripts/call.sh asana /tasks GET '{"assignee":"me","workspace":"{workspace_gid}","opt_fields":"name,due_on,completed,notes"}'
```

## Get a specific task
```bash
bash scripts/call.sh asana /tasks/{task_gid} GET '{"opt_fields":"name,notes,due_on,assignee,completed,projects"}'
```

## Create a task
```bash
bash scripts/call.sh asana /tasks POST '{"data":{"name":"New task","notes":"Task details","workspace":"{workspace_gid}","assignee":"me"}}'
```

## Update a task (mark complete)
```bash
bash scripts/call.sh asana /tasks/{task_gid} PUT '{"data":{"completed":true}}'
```

## List projects in a workspace
```bash
bash scripts/call.sh asana /projects GET '{"workspace":"{workspace_gid}","opt_fields":"name,status,due_date"}'
```

## Get tasks in a project
```bash
bash scripts/call.sh asana /projects/{project_gid}/tasks GET '{"opt_fields":"name,due_on,assignee,completed"}'
```

## Add a comment to a task
```bash
bash scripts/call.sh asana /tasks/{task_gid}/stories POST '{"data":{"text":"Update: completed the first phase"}}'
```

## Common use cases
- "What tasks are assigned to me in Asana?" → GET /tasks?assignee=me
- "Create a task 'Review PR' due Friday" → POST /tasks
- "Mark task X as complete" → PUT /tasks/{gid} with completed=true
- "What projects are in our workspace?" → GET /projects
- "List all tasks in project Y" → GET /projects/{gid}/tasks
