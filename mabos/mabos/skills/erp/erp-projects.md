# ERP Projects Tools

## Tool: `erp_projects`

Manage projects, tasks, and milestones. Track progress, assignments, budgets, and deadlines across the organization.

## Actions

### `create_project`

Create a new project.

**Parameters:**

- `name` (required) - Project name
- `description` (optional) - Project description
- `priority` (optional) - Priority (low, medium, high, critical)
- `budget` (optional) - Project budget amount
- `start_date` (optional) - Start date (ISO 8601)
- `end_date` (optional) - Target end date (ISO 8601)
- `owner_id` (optional) - Project owner/manager ID

**Example:**

```json
{
  "action": "create_project",
  "params": {
    "name": "Website Redesign",
    "description": "Full redesign of the public-facing website",
    "priority": "high",
    "budget": 50000,
    "start_date": "2026-03-01",
    "end_date": "2026-06-30",
    "owner_id": "emp_005"
  }
}
```

### `get_project`

Retrieve a project by ID.

**Parameters:**

- `id` (required) - Project ID

### `list_projects`

List projects with optional filters.

**Parameters:**

- `status` (optional) - Filter by status (planning, active, on_hold, completed)
- `owner_id` (optional) - Filter by owner
- `limit` (optional) - Max results

### `update_project`

Update project fields.

**Parameters:**

- `id` (required) - Project ID
- Additional fields to update (name, status, priority, budget, end_date)

### `create_task`

Add a task to a project.

**Parameters:**

- `project_id` (required) - Parent project ID
- `title` (required) - Task title
- `description` (optional) - Task details
- `priority` (optional) - Priority (low, medium, high, critical)
- `assignee_id` (optional) - Assigned team member
- `due_date` (optional) - Due date (ISO 8601)
- `estimated_hours` (optional) - Estimated effort in hours

**Example:**

```json
{
  "action": "create_task",
  "params": {
    "project_id": "proj_001",
    "title": "Design wireframes",
    "priority": "high",
    "assignee_id": "emp_012",
    "due_date": "2026-03-15",
    "estimated_hours": 20
  }
}
```

### `get_task`

Retrieve a task by ID.

**Parameters:**

- `id` (required) - Task ID

### `list_tasks`

List tasks with optional filters.

**Parameters:**

- `project_id` (optional) - Filter by project
- `status` (optional) - Filter by status (todo, in_progress, review, done)
- `assignee_id` (optional) - Filter by assignee
- `limit` (optional) - Max results

### `update_task`

Update task fields.

**Parameters:**

- `id` (required) - Task ID
- Additional fields to update (title, status, priority, assignee_id, due_date)

### `create_milestone`

Add a milestone to a project.

**Parameters:**

- `project_id` (required) - Parent project ID
- `title` (required) - Milestone title
- `due_date` (optional) - Target date (ISO 8601)

### `list_milestones`

List milestones for a project.

**Parameters:**

- `project_id` (required) - Project ID

### `complete_milestone`

Mark a milestone as completed.

**Parameters:**

- `id` (required) - Milestone ID

**Example:**

```json
{ "action": "complete_milestone", "params": { "id": "ms_003" } }
```

## Tips

- Break projects into milestones first, then decompose milestones into tasks.
- Use estimated_hours on tasks to enable workload planning and capacity checks.
- Filter tasks by assignee to generate individual workload reports.
- Complete milestones to track project progress at a high level.
- Link project budgets to `erp_finance` accounts for cost tracking.
