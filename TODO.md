# TODO

**This file is no longer the source of truth for OpenClaw tasks.**

All OpenClaw work tracking lives in **Todoist** now, in the `openclaw` project.

## Todoist project

- **Project name:** `openclaw`
- **Project ID:** `6g442XQJVrvqJhCp`
- **Web URL:** <https://app.todoist.com/app/project/openclaw-6g442XQJVrvqJhCp>

### Sections

| Section       | ID                 | Purpose                                                                 |
| ------------- | ------------------ | ----------------------------------------------------------------------- |
| `Not started` | `6g4FW6x4wF2gh84G` | Backlog — new work lands here by default                                |
| `In progress` | `6g4FW75cgqm39CMG` | Actively being worked on                                                |
| `Done`        | `6g4FW77rX473VXvp` | Completed (tasks can stay open here as a reference, or be fully closed) |

## Accessing Todoist from Claude Code

The [todoist-mcp](https://npm.im/todoist-mcp) MCP server is configured at user scope. Once a Claude Code session starts, it auto-connects and exposes tools under the `mcp__todoist__*` namespace. Common ones:

| Tool                                             | Use                                                        |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `mcp__todoist__get_projects_list`                | List all projects (including `openclaw`)                   |
| `mcp__todoist__get_sections_list`                | List sections for a project                                |
| `mcp__todoist__get_tasks_list`                   | List tasks in a project / section                          |
| `mcp__todoist__get_tasks_by_filter`              | Advanced filter queries (priority, labels, due date)       |
| `mcp__todoist__create_tasks`                     | Create one or more tasks (batch)                           |
| `mcp__todoist__update_tasks`                     | Edit existing tasks (content, priority, labels, due, etc.) |
| `mcp__todoist__close_tasks`                      | Mark tasks as completed                                    |
| `mcp__todoist__delete_tasks`                     | Permanently delete tasks                                   |
| `mcp__todoist__move_tasks`                       | Move tasks between projects / sections                     |
| `mcp__todoist__create_sections`                  | Create new sections                                        |
| `mcp__todoist__get_comments` / `create_comments` | Read/write task comments                                   |

### Quick example: list open OpenClaw tasks

```js
mcp__todoist__get_tasks_list({
  project_id: "6g442XQJVrvqJhCp",
  limit: 50,
});
```

### Quick example: add a new task to the backlog

```js
mcp__todoist__create_tasks({
  items: [
    {
      project_id: "6g442XQJVrvqJhCp",
      section_id: "6g4FW6x4wF2gh84G", // Not started
      content: "Brief task title",
      description: "Longer description with context, links, file paths, etc.",
      priority: 1, // P4 = 1, P3 = 2, P2 = 3, P1 = 4 (inverted from UI)
    },
  ],
});
```

## Priority mapping (important — the API is inverted from the UI)

| User-facing          | API `priority` value |
| -------------------- | -------------------- |
| P1 (urgent)          | `4`                  |
| P2 (high)            | `3`                  |
| P3 (medium)          | `2`                  |
| P4 (normal, default) | `1`                  |

## Labels

Useful labels already defined in Todoist for time estimates: `<15m`, `<30m`, `<45m`, `<1h`, `<1h30m`, `<2h`, `<3h`, `<4h`, `<6h` — plus matching `>...` variants. Tag tasks with these to help with planning sessions.

Other relevant labels: `Routine`, `Stretch`, `Discarded`.

## Adding tasks outside Claude Code

- **Todoist mobile / desktop app** — just add to the `openclaw` project
- **`openclaw` CLI skill** — if there's a `/todo` or equivalent slash command configured, use that
- **Todoist REST API** — `curl` with `Authorization: Bearer <API_TOKEN>` against `api.todoist.com/rest/v2/tasks` works anywhere (API token lives in keychain / the gateway config)

## Why this file still exists

It's a pointer for future Claude Code sessions (and you) that open the repo and look for `TODO.md`. Without this note, it's not obvious the tasks have moved. Do NOT add real tasks to this file — they'll get lost. Add them to Todoist.
