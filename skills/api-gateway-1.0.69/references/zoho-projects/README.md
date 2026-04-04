# Zoho Projects Routing Reference

**App name:** `zoho-projects`
**Base URL proxied:** `projectsapi.zoho.com`

## API Path Pattern

```
/zoho-projects/restapi/portals/
/zoho-projects/restapi/portal/{portal_id}/projects/
/zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/
/zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasklists/
/zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/milestones/
/zoho-projects/restapi/portal/{portal_id}/users/
```

## Important Notes

- All POST requests use `application/x-www-form-urlencoded`, not JSON
- Portal ID is required for most endpoints
- Date format: `MM-dd-yyyy`
- Empty lists return 204 No Content
- Deleted items go to trash, not permanently deleted

## Common Endpoints

### Portals

#### List Portals

```bash
GET /zoho-projects/restapi/portals/
```

#### Get Portal

```bash
GET /zoho-projects/restapi/portal/{portal_id}/
```

### Projects

#### List Projects

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/
```

#### Get Project

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/
```

#### Create Project

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/
Content-Type: application/x-www-form-urlencoded

name=New+Project
```

#### Update Project

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/
Content-Type: application/x-www-form-urlencoded

name=Updated+Name
```

#### Delete Project

```bash
DELETE /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/
```

### Tasks

#### List Tasks

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/
```

#### Get Task

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/{task_id}/
```

#### Get My Tasks

```bash
GET /zoho-projects/restapi/portal/{portal_id}/mytasks/
```

#### Create Task

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/
Content-Type: application/x-www-form-urlencoded

name=New+Task
```

#### Update Task

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/{task_id}/
Content-Type: application/x-www-form-urlencoded

name=Updated+Name&priority=High
```

#### Delete Task

```bash
DELETE /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/{task_id}/
```

### Task Comments

#### List Comments

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/{task_id}/comments/
```

#### Add Comment

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/{task_id}/comments/
Content-Type: application/x-www-form-urlencoded

content=Comment+text
```

### Tasklists

#### List Tasklists

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasklists/
```

#### Create Tasklist

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasklists/
Content-Type: application/x-www-form-urlencoded

name=New+Tasklist
```

### Milestones

#### List Milestones

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/milestones/
```

#### Create Milestone

```bash
POST /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/milestones/
Content-Type: application/x-www-form-urlencoded

name=Phase+1&start_date=03-01-2026&end_date=03-15-2026&owner={user_id}&flag=internal
```

### Users

#### List Users

```bash
GET /zoho-projects/restapi/portal/{portal_id}/users/
```

## Pagination

Use `index` and `range` query parameters:

```bash
GET /zoho-projects/restapi/portal/{portal_id}/projects/{project_id}/tasks/?index=1&range=50
```

## Resources

- [Zoho Projects API Documentation](https://www.zoho.com/projects/help/rest-api/zohoprojectsapi.html)
- [Projects API](https://www.zoho.com/projects/help/rest-api/projects-api.html)
- [Tasks API](https://www.zoho.com/projects/help/rest-api/tasks-api.html)
