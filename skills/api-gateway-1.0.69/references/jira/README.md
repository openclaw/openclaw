# Jira Routing Reference

**App name:** `jira`
**Base URL proxied:** `api.atlassian.com`

## Getting Cloud ID

Jira Cloud requires a cloud ID in the API path. First, get accessible resources:

```bash
GET /jira/oauth/token/accessible-resources
```

Response:

```json
[
  {
    "id": "62909843-b784-4c35-b770-e4e2a26f024b",
    "url": "https://yoursite.atlassian.net",
    "name": "yoursite",
    "scopes": ["read:jira-user", "read:jira-work", "write:jira-work"]
  }
]
```

## API Path Pattern

```
/jira/ex/jira/{cloudId}/rest/api/3/{endpoint}
```

## Common Endpoints

### List Projects

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/project
```

### Get Project

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/project/{projectKeyOrId}
```

### Search Issues (JQL)

Note: The old `/search` endpoint is deprecated. Use `/search/jql` with a bounded query.

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/search/jql?jql=project%3DKEY%20order%20by%20created%20DESC&maxResults=20&fields=summary,status,assignee,created,priority
```

### Get Issue

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}
```

### Create Issue

```bash
POST /jira/ex/jira/{cloudId}/rest/api/3/issue
Content-Type: application/json

{
  "fields": {
    "project": {"key": "PROJ"},
    "summary": "Issue summary",
    "issuetype": {"name": "Task"}
  }
}
```

### Update Issue

```bash
PUT /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}
Content-Type: application/json

{
  "fields": {
    "summary": "Updated summary"
  }
}
```

### Delete Issue

```bash
DELETE /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}
```

### Assign Issue

```bash
PUT /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}/assignee
Content-Type: application/json

{
  "accountId": "712020:5aff718e-6fe0-4548-82f4-f44ec481e5e7"
}
```

### Get Transitions

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}/transitions
```

### Transition Issue (change status)

```bash
POST /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}/transitions
Content-Type: application/json

{
  "transition": {"id": "31"}
}
```

### Add Comment

```bash
POST /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}/comment
Content-Type: application/json

{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Comment text"}]}]
  }
}
```

### Get Comments

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}/comment
```

### Users

#### Get Current User

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/myself
```

#### Search Users

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/user/search?query=john
```

### Metadata

#### List Issue Types

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/issuetype
```

#### List Priorities

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/priority
```

#### List Statuses

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/status
```

#### List Fields

```bash
GET /jira/ex/jira/{cloudId}/rest/api/3/field
```

## Notes

- Always fetch cloud ID first using `/oauth/token/accessible-resources`
- JQL queries must be bounded (e.g., `project=KEY`) - unbounded queries are rejected
- Use URL encoding for JQL query parameters
- Update, Delete, Transition, and Assign endpoints return HTTP 204 (No Content) on success
- Agile API (`/rest/agile/1.0/...`) requires additional OAuth scopes beyond the basic Jira scopes

## Resources

- [API Introduction](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
- [Search Issues (JQL)](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get)
- [Get Issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get)
- [Create Issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post)
- [Update Issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put)
- [Transition Issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-post)
- [Add Comment](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-post)
- [Get Projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-get)
- [JQL Reference](https://support.atlassian.com/jira-service-management-cloud/docs/use-advanced-search-with-jira-query-language-jql/)
