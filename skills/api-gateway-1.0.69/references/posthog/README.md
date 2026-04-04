# PostHog Routing Reference

**App name:** `posthog`
**Base URL proxied:** `{subdomain}.posthog.com`

## API Path Pattern

```
/posthog/api/{resource}
/posthog/api/projects/{project_id}/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /posthog/api/users/@me/
```

### Get Current Organization

```bash
GET /posthog/api/organizations/@current/
```

### List Projects

```bash
GET /posthog/api/projects/
```

### Get Current Project

```bash
GET /posthog/api/projects/@current/
```

### Run HogQL Query

```bash
POST /posthog/api/projects/{project_id}/query/
Content-Type: application/json

{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT event, count() FROM events GROUP BY event LIMIT 10"
  }
}
```

### List Persons

```bash
GET /posthog/api/projects/{project_id}/persons/?limit=10
```

### Get Person

```bash
GET /posthog/api/projects/{project_id}/persons/{person_uuid}/
```

### List Dashboards

```bash
GET /posthog/api/projects/{project_id}/dashboards/
```

### Get Dashboard

```bash
GET /posthog/api/projects/{project_id}/dashboards/{dashboard_id}/
```

### Create Dashboard

```bash
POST /posthog/api/projects/{project_id}/dashboards/
Content-Type: application/json

{
  "name": "My Dashboard",
  "description": "Analytics overview"
}
```

### List Insights

```bash
GET /posthog/api/projects/{project_id}/insights/?limit=10
```

### List Feature Flags

```bash
GET /posthog/api/projects/{project_id}/feature_flags/
```

### Create Feature Flag

```bash
POST /posthog/api/projects/{project_id}/feature_flags/
Content-Type: application/json

{
  "key": "my-feature-flag",
  "name": "My Feature Flag",
  "active": true,
  "filters": {
    "groups": [{"rollout_percentage": 100}]
  }
}
```

### Delete Feature Flag

Use soft delete by setting `deleted: true`:

```bash
PATCH /posthog/api/projects/{project_id}/feature_flags/{flag_id}/
Content-Type: application/json

{
  "deleted": true
}
```

### List Session Recordings

```bash
GET /posthog/api/projects/{project_id}/session_recordings/?limit=10
```

### List Cohorts

```bash
GET /posthog/api/projects/{project_id}/cohorts/
```

### List Actions

```bash
GET /posthog/api/projects/{project_id}/actions/
```

### List Experiments

```bash
GET /posthog/api/projects/{project_id}/experiments/
```

### List Surveys

```bash
GET /posthog/api/projects/{project_id}/surveys/
```

### List Event Definitions

```bash
GET /posthog/api/projects/{project_id}/event_definitions/?limit=10
```

### List Property Definitions

```bash
GET /posthog/api/projects/{project_id}/property_definitions/?limit=10
```

## Notes

- Use `@current` as a shortcut for the current project ID (e.g., `/api/projects/@current/dashboards/`)
- Project IDs are integers (e.g., `136209`)
- Person UUIDs are in standard UUID format
- The Events endpoint is deprecated; use the Query endpoint with HogQL instead
- All project-scoped endpoints require `{project_id}` or `@current`
- Pagination uses `limit` and `offset` query parameters
- PostHog uses soft delete: use `PATCH` with `{"deleted": true}` instead of HTTP DELETE

## Resources

- [PostHog API Overview](https://posthog.com/docs/api)
- [HogQL Documentation](https://posthog.com/docs/hogql)
- [Feature Flags](https://posthog.com/docs/feature-flags)
- [Session Replay](https://posthog.com/docs/session-replay)
- [Experiments](https://posthog.com/docs/experiments)
