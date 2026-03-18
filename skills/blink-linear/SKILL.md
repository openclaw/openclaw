---
name: blink-linear
description: >
  Create and manage Linear issues, projects, and cycles using the Linear GraphQL
  API. Use when asked to create tickets, update issue status, assign work, or
  query project progress. Requires a linked Linear connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "linear" } }
---

# Blink Linear

Access the user's linked Linear workspace. Provider key: `linear`.

Note: Linear uses GraphQL. The `method` argument is the full GraphQL query/mutation string.

## List recent issues
```bash
bash scripts/call.sh linear 'query { issues(first: 20, orderBy: updatedAt) { nodes { id title state { name } assignee { name } priority } } }' POST
```

## Get issues for a specific team
```bash
bash scripts/call.sh linear 'query { team(id: "TEAM_ID") { issues(first: 20) { nodes { id title state { name } } } } }' POST
```

## Create an issue
```bash
bash scripts/call.sh linear 'mutation { issueCreate(input: { title: "Fix login bug", description: "Steps...", teamId: "TEAM_ID", priority: 2 }) { issue { id title url } } }' POST
```

## Update issue status
```bash
bash scripts/call.sh linear 'mutation { issueUpdate(id: "ISSUE_ID", input: { stateId: "STATE_ID" }) { issue { id title state { name } } } }' POST
```

## List teams
```bash
bash scripts/call.sh linear 'query { teams { nodes { id name key } } }' POST
```

## Get my assigned issues
```bash
bash scripts/call.sh linear 'query { viewer { assignedIssues(first: 20) { nodes { id title state { name } priority } } } }' POST
```

## Common use cases
- "Create a Linear ticket for the auth bug" → issueCreate mutation
- "What issues are in progress?" → query issues filtered by state
- "Assign issue X to me" → issueUpdate mutation
- "List all open issues in team Engineering" → team query with issues
- "Mark issue X as done" → issueUpdate with done state
