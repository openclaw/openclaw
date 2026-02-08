---
name: todoist
description: Manage tasks and projects in Todoist. Use when user asks about tasks, to-dos, reminders, or productivity.
homepage: https://todoist.com
metadata:
  clawdbot:
    emoji: "✅"
    requires:
      bins: ["todoist"]
      env: ["TODOIST_API_TOKEN"]
---

# Todoist CLI

CLI for Todoist task management, built on the official TypeScript SDK.

## Installation

```bash
# Requires todoist-ts-cli >= 0.2.0 (for --top / --order)
npm install -g todoist-ts-cli@^0.2.0
```

## Setup

1. Get API token from https://todoist.com/app/settings/integrations/developer
2. Either:
   ```bash
   todoist auth <your-token>
   # or
   export TODOIST_API_TOKEN="your-token"
   ```

## Commands

### Tasks

```bash
todoist                    # Show today's tasks (default)
todoist today              # Same as above
todoist tasks              # List tasks (today + overdue)
todoist tasks --all        # All tasks
todoist tasks -p "Work"    # Tasks in project
todoist tasks -f "p1"      # Filter query (priority 1)
todoist tasks --json
```

### Add Tasks

```bash
todoist add "Buy groceries"
todoist add "Meeting" --due "tomorrow 10am"
todoist add "Review PR" --due "today" --priority 1 --project "Work"
todoist add "Prep slides" --project "Work" --order 3  # add at a specific position (1-based)
todoist add "Triage inbox" --project "Work" --order top  # add to top (alternative to --top)
todoist add "Call mom" -d "sunday" -l "family"  # with label
```

### Manage Tasks

```bash
todoist view <id>          # View task details
todoist done <id>          # Complete task
todoist reopen <id>        # Reopen completed task
todoist update <id> --due "next week"
todoist move <id> -p "Personal"
todoist delete <id>
```

### Search

```bash
todoist search "meeting"
```

### Projects & Labels

```bash
todoist projects           # List projects
todoist project-add "New Project"
todoist labels             # List labels
todoist label-add "urgent"
```

### Comments

```bash
todoist comments <task-id>
todoist comment <task-id> "Note about this task"
```

## Usage Examples

**User: "What do I have to do today?"**
```bash
todoist today
```

**User: "Add 'buy milk' to my tasks"**
```bash
todoist add "Buy milk" --due "today"
```

**User: "Remind me to call the dentist tomorrow"**
```bash
todoist add "Call the dentist" --due "tomorrow"
```

**User: "Mark the grocery task as done"**
```bash
todoist search "grocery"   # Find task ID
todoist done <id>
```

**User: "What's on my work project?"**
```bash
todoist tasks -p "Work"
```

**User: "Show my high priority tasks"**
```bash
todoist tasks -f "p1"
```

## Filter Syntax

Todoist supports powerful filter queries:
- `p1`, `p2`, `p3`, `p4` - Priority levels
- `today`, `tomorrow`, `overdue`
- `@label` - Tasks with label
- `#project` - Tasks in project
- `search: keyword` - Search

## Notes

- Task IDs are shown in task listings
- Due dates support natural language ("tomorrow", "next monday", "jan 15")
- Priority 1 is highest, 4 is lowest
- Use `--order <n>` (1-based) or `--order top` to insert a task at a specific position within a project/section
