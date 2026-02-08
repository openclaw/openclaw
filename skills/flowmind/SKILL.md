---
name: flowmind
description: Manage productivity with FlowMind — goals, tasks (with subtasks), notes, people, and tags via REST API. Use when the user wants to create, list, update, or delete goals, tasks, notes, contacts, or tags; manage focus/priorities; track progress; or organize their productivity workspace through FlowMind.
---

# FlowMind

[FlowMind](https://flowmind.life/) is a personalized productivity workspace that brings your goals, tasks, notes, and contacts together in one place. Unlike rigid project management tools, FlowMind adapts to how you actually think and work — linking tasks to bigger goals, tagging by energy level and focus needs, and giving you a clear view of what matters most right now. Beyond task management, FlowMind helps you nurture your network, schedule meetings, and track habits — all the pieces of a productive life that usually live in separate apps. Best of all, most features are accessible through natural language via AI, so you can manage your workflow just by saying what you need.

## Setup

Set these in your agent config or environment:
- `FLOWMIND_API_KEY` — Bearer token from your FlowMind account (Settings → API Keys)
- Base URL: `https://flowmind.life/api/v1`

All requests use `Authorization: Bearer <FLOWMIND_API_KEY>` and `Content-Type: application/json`.

## Quick Reference

### Goals
```
GET    /goals              — list (filter: status, category, pinned; sort: title, target_date, progress)
POST   /goals              — create (required: title)
GET    /goals/:id          — get
PATCH  /goals/:id          — update
DELETE /goals/:id          — delete
GET    /goals/:id/tasks    — list tasks for goal
```
Fields: title, description, status (active/completed/archived), category (business/career/health/personal/learning/financial), target_date, progress (0-100), pinned

### Tasks
```
GET    /tasks              — list (filter: status, priority, energy_level, goal_id, person_id, due_date_from/to, focused, focus_today)
POST   /tasks              — create (required: title)
GET    /tasks/:id          — get
PATCH  /tasks/:id          — update
DELETE /tasks/:id          — delete
GET    /tasks/:id/subtasks — list subtasks
POST   /tasks/:id/subtasks — create subtask
```
Fields: title, description, status (todo/in_progress/completed/archived), priority (low/medium/high/urgent), energy_level (low/medium/high), due_date, scheduled_time, goal_id, person_id, parent_task_id, estimated_minutes, actual_minutes, pinned, focused, focus_today, focus_order, icon

### Notes
```
GET    /notes    — list (filter: category, task_id, pinned)
POST   /notes    — create (required: title)
GET    /notes/:id
PATCH  /notes/:id
DELETE /notes/:id
```
Fields: title, content, category, task_id, is_protected, pinned

### People
```
GET    /people             — list (filter: relationship_type, tag_id, search)
POST   /people             — create (required: name)
GET    /people/:id
PATCH  /people/:id
DELETE /people/:id
GET    /people/:id/tags    — list tags
POST   /people/:id/tags    — add tag (body: {tag_id})
DELETE /people/:id/tags/:tagId
```
Fields: name, email, phone, company, role, relationship_type (business/colleague/friend/family/mentor/client/partner/other), notes, birth_month, birth_day, location, last_met_date

### Tags
```
GET    /tags    — list (sort: name, created_at)
POST   /tags    — create (required: name; optional: color)
GET    /tags/:id
PATCH  /tags/:id
DELETE /tags/:id
```

## Pagination & Sorting
- `page` (default 1), `limit` (default 20, max 100)
- `sort` field name, `order=asc|desc`

## Response Format
```json
{ "data": [...], "meta": { "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3, "hasMore": true } } }
```

## Error Handling
Errors return `{ "error": { "code": "...", "message": "...", "details": [] } }`. Codes: BAD_REQUEST, UNAUTHORIZED, NOT_FOUND, VALIDATION_ERROR, RATE_LIMITED.

## Common Workflows

**Daily focus**: `GET /tasks?focus_today=true` to see today's focus list. Toggle with `PATCH /tasks/:id { "focus_today": true }`.

**Goal tracking**: Create a goal, link tasks via `goal_id`, check progress with `GET /goals/:id`.

**Meeting prep**: `GET /people/:id` + `GET /tasks?person_id=:id` to review context before meetings.

For full API details, see [references/api.md](references/api.md).
