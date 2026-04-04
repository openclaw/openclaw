# Sunsama MCP Routing Reference

**App name:** `sunsama`
**Base URL proxied:** MCP server

## Connection Management

Manage MCP connections at `https://ctrl.maton.ai`.

### List Connections

```bash
GET https://ctrl.maton.ai/connections?app=sunsama&method=MCP&status=ACTIVE
Authorization: Bearer $MATON_API_KEY
```

### Create Connection

```bash
POST https://ctrl.maton.ai/connections
Content-Type: application/json
Authorization: Bearer $MATON_API_KEY

{
  "app": "sunsama",
  "method": "MCP"
}
```

## API Path Pattern

```
/sunsama/{tool-name}
```

## MCP Reference

All MCP tools use `POST` method:

| Tool                         | Description              | Schema                                            |
| ---------------------------- | ------------------------ | ------------------------------------------------- |
| `search_tasks`               | Search tasks by keyword  | [schema](schemas/search_tasks.json)               |
| `create_task`                | Create a new task        | [schema](schemas/create_task.json)                |
| `edit_task_title`            | Update task title        | [schema](schemas/edit_task_title.json)            |
| `delete_task`                | Delete a task            | [schema](schemas/delete_task.json)                |
| `mark_task_as_completed`     | Mark task complete       | [schema](schemas/mark_task_as_completed.json)     |
| `mark_task_as_incomplete`    | Mark task incomplete     | [schema](schemas/mark_task_as_incomplete.json)    |
| `append_task_notes`          | Add notes to task        | [schema](schemas/append_task_notes.json)          |
| `edit_task_time_estimate`    | Set time estimate        | [schema](schemas/edit_task_time_estimate.json)    |
| `add_subtasks_to_task`       | Add subtasks             | [schema](schemas/add_subtasks_to_task.json)       |
| `get_backlog_tasks`          | List backlog tasks       | [schema](schemas/get_backlog_tasks.json)          |
| `move_task_to_backlog`       | Move task to backlog     | [schema](schemas/move_task_to_backlog.json)       |
| `move_task_from_backlog`     | Move from backlog to day | [schema](schemas/move_task_from_backlog.json)     |
| `move_task_to_day`           | Reschedule task          | [schema](schemas/move_task_to_day.json)           |
| `create_calendar_event`      | Create calendar event    | [schema](schemas/create_calendar_event.json)      |
| `timebox_a_task_to_calendar` | Block time for task      | [schema](schemas/timebox_a_task_to_calendar.json) |
| `start_task_timer`           | Start timer              | [schema](schemas/start_task_timer.json)           |
| `stop_task_timer`            | Stop timer               | [schema](schemas/stop_task_timer.json)            |
| `create_weekly_objective`    | Create weekly goal       | [schema](schemas/create_weekly_objective.json)    |
| `create_braindump_task`      | Create backlog task      | [schema](schemas/create_braindump_task.json)      |
| `create_channel`             | Create channel/context   | [schema](schemas/create_channel.json)             |

## Common Endpoints

### Search Tasks

```bash
POST /sunsama/search_tasks
Content-Type: application/json

{
  "searchTerm": "meeting"
}
```

### Create Task

```bash
POST /sunsama/create_task
Content-Type: application/json

{
  "title": "Review quarterly report",
  "day": "2026-03-03",
  "alreadyInTaskList": false
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"success\":true,\"task\":{\"_id\":\"69a6bf3a04d3cd0001595308\",\"title\":\"Review quarterly report\",\"scheduledDate\":\"2026-03-03\",\"completed\":false}}"
    }
  ],
  "isError": false
}
```

### Get Backlog Tasks

```bash
POST /sunsama/get_backlog_tasks
Content-Type: application/json

{}
```

### Mark Task as Completed

```bash
POST /sunsama/mark_task_as_completed
Content-Type: application/json

{
  "taskId": "69a6bf3a04d3cd0001595308",
  "finishedDay": "2026-03-03"
}
```

### Create Braindump Task

```bash
POST /sunsama/create_braindump_task
Content-Type: application/json

{
  "title": "Research new tools",
  "timeBucket": "in the next month"
}
```

**Time bucket options:**

- `"in the next two weeks"`
- `"in the next month"`
- `"in the next quarter"`
- `"in the next year"`
- `"someday"`
- `"never"`

### Timebox Task to Calendar

```bash
POST /sunsama/timebox_a_task_to_calendar
Content-Type: application/json

{
  "taskId": "69a6bf3a04d3cd0001595308",
  "startDate": "2026-03-03",
  "startTime": "14:00"
}
```

## Notes

- All task IDs are MongoDB ObjectIds (24-character hex strings)
- Date format: `YYYY-MM-DD` for days, ISO 8601 for datetimes
- MCP tool responses wrap content in `{"content": [{"type": "text", "text": "..."}], "isError": false}` format
- The `text` field contains JSON-stringified data that should be parsed
- If multiple Sunsama connections exist, specify which to use with `Maton-Connection` header

## Resources

- [Sunsama](https://sunsama.com)
- [Maton Community](https://discord.com/invite/dBfFAcefs2)
- [Maton Support](mailto:support@maton.ai)
