# FlowMind API Reference

**Base URL:** `https://flowmind.life/api/v1`
**Auth:** Bearer token (`Authorization: Bearer <API_KEY>`)

## Goals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /goals | List goals (filter: status, category, pinned; sort: created_at, updated_at, title, target_date, progress) |
| POST | /goals | Create goal (required: title; optional: description, status, category, target_date, progress, pinned) |
| GET | /goals/:id | Get a goal |
| PATCH | /goals/:id | Update a goal |
| DELETE | /goals/:id | Delete a goal |
| GET | /goals/:id/tasks | List tasks for a goal |

**Fields:** id, title, description, status (active/completed/archived), category (business/career/health/personal/learning/financial), target_date, progress (0-100), pinned, created_at, updated_at

## Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /tasks | List tasks (filter: status, priority, energy_level, goal_id, person_id, parent_task_id, due_date_from/to, pinned, focused, focus_today) |
| POST | /tasks | Create task (required: title) |
| GET | /tasks/:id | Get a task |
| PATCH | /tasks/:id | Update a task |
| DELETE | /tasks/:id | Delete a task |
| GET | /tasks/:id/subtasks | List subtasks |
| POST | /tasks/:id/subtasks | Create subtask |

**Fields:** id, title, description, status (todo/in_progress/completed/archived), priority (low/medium/high/urgent), energy_level (low/medium/high), due_date, scheduled_time, goal_id, person_id, parent_task_id, estimated_minutes, actual_minutes, pinned, focused, focus_today, focus_order, icon, created_at, updated_at

## Notes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /notes | List notes (filter: category, task_id, pinned) |
| POST | /notes | Create note (required: title) |
| GET | /notes/:id | Get a note |
| PATCH | /notes/:id | Update a note |
| DELETE | /notes/:id | Delete a note |

**Fields:** id, title, content, category, task_id, is_protected, pinned, created_at

## People

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /people | List people (filter: relationship_type, tag_id, search) |
| POST | /people | Create person (required: name) |
| GET | /people/:id | Get a person |
| PATCH | /people/:id | Update a person |
| DELETE | /people/:id | Delete a person |
| GET | /people/:id/tags | List tags for person |
| POST | /people/:id/tags | Add tag to person (body: {tag_id}) |
| DELETE | /people/:id/tags/:tagId | Remove tag from person |

**Fields:** id, name, email, phone, company, role, relationship_type (business/colleague/friend/family/mentor/client/partner/other), notes, avatar_url, birth_month, birth_day, zodiac_sign, mbti_type, location, latitude, longitude, last_met_date, created_at, updated_at

## Tags

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /tags | List tags (sort: name, created_at) |
| POST | /tags | Create tag (required: name; optional: color) |
| GET | /tags/:id | Get a tag |
| PATCH | /tags/:id | Update a tag |
| DELETE | /tags/:id | Delete a tag |

**Fields:** id, name, color, created_at

## Common Parameters
- Pagination: `page` (default 1), `limit` (default 20, max 100)
- Sort order: `order=asc|desc` (default desc)
- Responses: `{ data: ..., meta: { pagination: { page, limit, total, totalPages, hasMore } } }`
- Errors: `{ error: { code, message, details[] } }`
