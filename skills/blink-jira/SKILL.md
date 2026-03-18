---
name: blink-jira
description: >
  Create and manage Jira issues, sprints, and projects via the Atlassian API.
  Use when asked to create tickets, update issue status, search issues, or check
  sprint progress. Requires a linked Jira connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "jira" } }
---

# Blink Jira

Access the user's linked Jira workspace. Provider key: `jira`.

## Search issues with JQL
```bash
bash scripts/call.sh jira /search GET '{"jql":"assignee=currentUser() AND status!=Done","maxResults":20}'
```

## Get a specific issue
```bash
bash scripts/call.sh jira /issue/{issueKey} GET
```

## Create an issue
```bash
bash scripts/call.sh jira /issue POST '{
  "fields": {
    "project": {"key": "PROJ"},
    "summary": "Fix login bug",
    "description": {"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Steps to reproduce..."}]}]},
    "issuetype": {"name": "Bug"}
  }
}'
```

## Update issue status (transition)
```bash
bash scripts/call.sh jira /issue/{issueKey}/transitions POST '{"transition":{"id":"{transitionId}"}}'
```

## Get available transitions for an issue
```bash
bash scripts/call.sh jira /issue/{issueKey}/transitions GET
```

## Add a comment
```bash
bash scripts/call.sh jira /issue/{issueKey}/comment POST '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Comment text here"}]}]}}'
```

## List projects
```bash
bash scripts/call.sh jira /project GET
```

## Get sprint issues
```bash
bash scripts/call.sh jira /search GET '{"jql":"sprint in openSprints()","maxResults":50}'
```

## Common use cases
- "Create a Jira bug ticket for the payment issue" → POST /issue
- "What tickets are assigned to me?" → GET /search?jql=assignee=currentUser()
- "Mark ticket PROJ-123 as done" → POST /issue/{key}/transitions
- "List all issues in the current sprint" → GET /search?jql=sprint in openSprints()
- "Add a comment to PROJ-456" → POST /issue/{key}/comment
