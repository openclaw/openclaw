# Linear Routing Reference

**App name:** `linear`
**Base URL proxied:** `api.linear.app`

## API Type

Linear uses a GraphQL API exclusively. All requests are POST requests to the `/graphql` endpoint.

## API Path Pattern

```
/linear/graphql
```

All operations use POST with a JSON body containing the `query` field.

## Common Operations

### Get Current User (Viewer)

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ viewer { id name email } }"
}
```

### Get Organization

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ organization { id name urlKey } }"
}
```

### List Teams

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ teams { nodes { id name key } } }"
}
```

### List Issues

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ issues(first: 20) { nodes { id identifier title state { name } priority } pageInfo { hasNextPage endCursor } } }"
}
```

### Get Issue by Identifier

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ issue(id: \"MTN-527\") { id identifier title description state { name } priority assignee { name } team { key } createdAt } }"
}
```

### Filter Issues by State

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ issues(first: 20, filter: { state: { type: { eq: \"started\" } } }) { nodes { id identifier title state { name } } } }"
}
```

### Search Issues

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ searchIssues(first: 20, term: \"search term\") { nodes { id identifier title } } }"
}
```

### Create Issue

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "mutation { issueCreate(input: { teamId: \"TEAM_ID\", title: \"Issue title\", description: \"Description\" }) { success issue { id identifier title } } }"
}
```

### Update Issue

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "mutation { issueUpdate(id: \"ISSUE_ID\", input: { title: \"Updated title\", priority: 2 }) { success issue { id identifier title priority } } }"
}
```

### Create Comment

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "mutation { commentCreate(input: { issueId: \"ISSUE_ID\", body: \"Comment text\" }) { success comment { id body } } }"
}
```

### List Projects

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ projects(first: 20) { nodes { id name state createdAt } } }"
}
```

### List Labels

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ issueLabels(first: 50) { nodes { id name color } } }"
}
```

### List Workflow States

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ workflowStates(first: 50) { nodes { id name type team { key } } } }"
}
```

### List Users

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ users(first: 50) { nodes { id name email active } } }"
}
```

### List Cycles

```bash
POST /linear/graphql
Content-Type: application/json

{
  "query": "{ cycles(first: 20) { nodes { id name number startsAt endsAt } } }"
}
```

## Pagination

Linear uses Relay-style cursor-based pagination:

```bash
# First page
POST /linear/graphql
{
  "query": "{ issues(first: 20) { nodes { id identifier title } pageInfo { hasNextPage endCursor } } }"
}

# Next page
POST /linear/graphql
{
  "query": "{ issues(first: 20, after: \"CURSOR_VALUE\") { nodes { id identifier title } pageInfo { hasNextPage endCursor } } }"
}
```

## Notes

- Linear uses GraphQL exclusively (no REST API)
- Issue identifiers (e.g., `MTN-527`) can be used in place of UUIDs for the `id` parameter
- Priority values: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
- Workflow state types: `backlog`, `unstarted`, `started`, `completed`, `canceled`
- Some mutations (delete, create labels/projects) may require additional OAuth scopes
- Use `searchIssues(term: "...")` for full-text search
- Filter operators: `eq`, `neq`, `in`, `nin`, `containsIgnoreCase`, etc.

## Resources

- [Linear API Overview](https://linear.app/developers)
- [Linear GraphQL Getting Started](https://linear.app/developers/graphql)
- [Linear GraphQL Schema (Apollo Studio)](https://studio.apollographql.com/public/Linear-API/schema/reference?variant=current)
- [Linear API and Webhooks](https://linear.app/docs/api-and-webhooks)
