# Linear GraphQL API Reference

Reference for Linear GraphQL queries and mutations. Consult when building custom queries or extending the skill.

## API Endpoint

```
POST https://api.linear.app/graphql
Authorization: <LINEAR_API_KEY>
Content-Type: application/json
```

## Common Queries

### Get Viewer (Current User)

```graphql
query Viewer {
  viewer {
    id
    email
    name
  }
}
```

### List Teams

```graphql
query Teams {
  teams {
    nodes {
      id
      key
      name
    }
  }
}
```

### List Issues with Filters

```graphql
query Issues($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first) {
    nodes {
      id
      identifier
      title
      description
      state {
        id
        name
      }
      assignee {
        id
        name
        email
      }
      priority
      labels {
        nodes {
          id
          name
        }
      }
      createdAt
      updatedAt
      url
    }
  }
}
```

**Variables:**

```json
{
  "filter": {
    "team": { "id": { "eq": "team-uuid" } },
    "state": { "name": { "eq": "In Progress" } },
    "assignee": { "id": { "eq": "user-uuid" } }
  },
  "first": 10
}
```

### Get Single Issue

```graphql
query Issue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state {
      name
    }
    assignee {
      name
      email
    }
    priority
    createdAt
    updatedAt
    url
    labels {
      nodes {
        name
      }
    }
    attachments {
      nodes {
        id
        url
        title
      }
    }
    comments {
      nodes {
        id
        body
        createdAt
        user {
          name
        }
      }
    }
  }
}
```

**Variables:**

```json
{ "id": "STX-41" }
```

### Get Workflow States for Team

```graphql
query TeamStates($teamId: String!) {
  team(id: $teamId) {
    states {
      nodes {
        id
        name
        type
      }
    }
  }
}
```

**State types:** `backlog`, `unstarted`, `started`, `completed`, `canceled`

### List Users

```graphql
query Users {
  users {
    nodes {
      id
      name
      email
      active
    }
  }
}
```

## Common Mutations

### Create Issue

```graphql
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}
```

**Variables:**

```json
{
  "input": {
    "title": "Fix reminder dismiss action",
    "description": "ReminderReceiver dismiss button has no handler...",
    "teamId": "team-uuid",
    "priority": 2,
    "stateId": "state-uuid",
    "assigneeId": "user-uuid"
  }
}
```

### Update Issue

```graphql
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
    }
  }
}
```

**Variables:**

```json
{
  "id": "issue-uuid",
  "input": {
    "stateId": "state-uuid",
    "assigneeId": "user-uuid",
    "priority": 1
  }
}
```

### Create Comment

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
    }
  }
}
```

**Variables:**

```json
{
  "input": {
    "issueId": "issue-uuid",
    "body": "Updated implementation approach..."
  }
}
```

### Create Attachment

```graphql
mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment {
      id
      url
    }
  }
}
```

**Variables:**

```json
{
  "input": {
    "issueId": "issue-uuid",
    "url": "https://github.com/user/repo/pull/123",
    "title": "Fix: ReminderReceiver dismiss"
  }
}
```

## Priority Values

- `0` - No priority
- `1` - Urgent 🔴
- `2` - High 🟠
- `3` - Normal/Medium 🟡
- `4` - Low ⚪

## Filter Operators

Common filter operators for queries:

- `eq` - Equals
- `neq` - Not equals
- `in` - In list
- `nin` - Not in list
- `contains` - String contains
- `startsWith` - String starts with
- `endsWith` - String ends with

**Example:**

```json
{
  "filter": {
    "state": { "name": { "in": ["Todo", "In Progress"] } },
    "priority": { "eq": 2 }
  }
}
```

## Pagination

Linear uses cursor-based pagination:

```graphql
query Issues($after: String, $first: Int) {
  issues(after: $after, first: $first) {
    nodes { ... }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Use `pageInfo.endCursor` as `after` for the next page.

## Rate Limits

- **Standard:** 1,500 requests per hour
- **Bursts:** Up to 50 requests per minute

The API returns rate limit headers:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Error Handling

Errors are returned in the `errors` array:

```json
{
  "errors": [
    {
      "message": "Field 'invalidField' doesn't exist on type 'Issue'",
      "extensions": {
        "code": "GRAPHQL_VALIDATION_FAILED"
      }
    }
  ]
}
```

Common error codes:

- `GRAPHQL_VALIDATION_FAILED` - Invalid query syntax
- `UNAUTHENTICATED` - Missing/invalid API key
- `FORBIDDEN` - Insufficient permissions
- `NOT_FOUND` - Entity doesn't exist

## Links

- **API Docs:** https://developers.linear.app/docs/graphql/working-with-the-graphql-api
- **Schema Explorer:** https://studio.apollographql.com/public/Linear-API/variant/current/home
- **API Playground:** https://linear.app/linear/settings/api (bottom of page)
