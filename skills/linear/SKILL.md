---
name: linear
description: Interact with Linear project management via GraphQL API. Use when creating issues from code reviews/specs/architecture decisions, querying current sprint/backlog, updating issue status, adding comments, linking commits/PRs, or checking project state. Supports teams/projects, priorities, statuses, assignees, comments, and URL attachments.
---

# Linear Project Management

Interact with Linear's issue tracking via GraphQL API.

## Setup

**Required:** LINEAR_API_KEY environment variable

```bash
export LINEAR_API_KEY="lin_api_..."
```

Get your API key from: https://linear.app/settings/api

Store in `.env` or secure storage (not in repo).

## Core Operations

### Create Issue

```bash
python3 scripts/linear.py create \
  --title "Fix reminder dismiss action" \
  --description "ReminderReceiver dismiss button has no handler..." \
  --project STX \
  --priority 2
```

**Priorities:**

- 1 = Urgent 🔴
- 2 = High 🟠
- 3 = Medium 🟡
- 4 = Low ⚪

### Update Issue

```bash
# Update status
python3 scripts/linear.py update STX-41 --status "In Progress"

# Assign to yourself
python3 scripts/linear.py update STX-41 --assignee @me

# Assign to someone else
python3 scripts/linear.py update STX-41 --assignee user@example.com

# Update title
python3 scripts/linear.py update STX-41 --title "New improved title"

# Update priority
python3 scripts/linear.py update STX-41 --priority 2

# Combined
python3 scripts/linear.py update STX-41 --status "In Progress" --assignee @me --priority 2 --title "Revised title"
```

### Query Issues

```bash
# All issues in project
python3 scripts/linear.py query --project STX

# Filter by status
python3 scripts/linear.py query --project STX --status "Todo"

# Your assigned issues
python3 scripts/linear.py query --assignee @me --limit 5

# Combined filters
python3 scripts/linear.py query --project STX --status "In Progress" --assignee @me
```

### Add Comment

```bash
python3 scripts/linear.py comment STX-41 "Updated implementation approach: use NotificationCompat.EXTRA_DISMISS_INTENT instead of custom receiver"
```

### Link URL (PR/Commit/Doc)

```bash
# Link GitHub PR
python3 scripts/linear.py link STX-41 --url "https://github.com/user/repo/pull/123"

# Link with custom title
python3 scripts/linear.py link STX-41 \
  --url "https://github.com/user/repo/pull/123" \
  --title "Fix: ReminderReceiver dismiss action"
```

### Show Issue Details

```bash
python3 scripts/linear.py show STX-41
```

Output includes: title, description, status, assignee, priority, labels, URLs, timestamps

## Common Workflows

### From Code Review → Linear Issues

When a code review identifies bugs/improvements:

```bash
# Create high-priority bug
python3 scripts/linear.py create \
  --title "Fix: Lint NewApi error in RecurringRuleMapper" \
  --description "RecurringRuleMapper uses java.time.DayOfWeek (API 26) with minSdk 24. Enable core library desugaring." \
  --project STX \
  --priority 2

# Create tech debt issue
python3 scripts/linear.py create \
  --title "Refactor: Domain layer depends on data-sync" \
  --description "Move sync contracts out of data-sync implementation..." \
  --project STX \
  --priority 3
```

### Track Implementation Progress

```bash
# Start work
python3 scripts/linear.py update STX-41 --status "In Progress" --assignee @me

# Revise title after scoping
python3 scripts/linear.py update STX-41 --title "Fix: ReminderReceiver dismiss + add tests"

# Escalate priority if blocker found
python3 scripts/linear.py update STX-41 --priority 1

# Add implementation notes
python3 scripts/linear.py comment STX-41 "Approach: use NotificationCompat dismiss intent instead of custom broadcast receiver"

# Link commit when done
python3 scripts/linear.py link STX-41 --url "https://github.com/user/repo/commit/abc123"

# Close
python3 scripts/linear.py update STX-41 --status "Done"
```

### Sprint Planning

```bash
# See current sprint backlog
python3 scripts/linear.py query --project STX --status "Todo" --limit 20

# Check in-progress work
python3 scripts/linear.py query --project STX --status "In Progress"

# Your assigned tasks
python3 scripts/linear.py query --assignee @me
```

## Status Values

Status names are team-specific. Common defaults:

- **Backlog**
- **Todo**
- **In Progress**
- **In Review**
- **Done**
- **Canceled**

Query your team's statuses: they'll be shown in error messages if you use an invalid status.

## Error Handling

**API key missing:**

```
Error: LINEAR_API_KEY environment variable not set
Get your API key from https://linear.app/settings/api
```

**Unknown project:**

```
Error: Team/project 'XYZ' not found
Available teams: STX, ABC, DEF
```

**Invalid status:**

```
Error: Status 'invalid' not found
Available statuses: Backlog, Todo, In Progress, Done
```

## Tips

- Use `@me` for assignee when you're taking the task
- Link commits/PRs immediately after pushing (creates audit trail)
- Add comments for non-obvious implementation decisions
- Query before creating to avoid duplicates
- Use priority 2 (High) for bugs blocking release
- Use priority 3 (Medium) for tech debt and improvements

## Examples

**Create issues from architecture decisions:**

```bash
python3 scripts/linear.py create \
  --title "Implement SMB playback proxy (NanoHTTPD)" \
  --description "See docs/DESIGN_SMB_PLAYBACK.md for full spec..." \
  --project STX \
  --priority 3
```

**Batch create from spec evaluation:**

```bash
# Critical bugs
python3 scripts/linear.py create --title "Fix: ReminderReceiver dismiss" --description "..." --project STX --priority 2

# Feature gaps
python3 scripts/linear.py create --title "Add variable playback speed" --description "..." --project STX --priority 3
```

**Track work across sessions:**

```bash
# At start of day
python3 scripts/linear.py query --assignee @me --status "In Progress"

# When context switching
python3 scripts/linear.py comment STX-42 "Blocked: waiting on design decision for sync merge strategy"
python3 scripts/linear.py update STX-42 --status "Blocked"
```
