---
name: jira-cloud
description: Execute Jira Cloud read/write workflows safely with explicit tool selection and confirmation.
metadata: { "openclaw": { "emoji": "🎫" } }
---

Use this skill when the user asks to work with Jira Cloud issues, projects, comments, transitions, assignment, or creation workflows.

## Operating Modes

1. Exploration / Read-only
- Validate integration and permissions with `jira_healthcheck`.
- Discover projects with `jira_list_projects`.
- Search with JQL via `jira_search_issues`.
- Inspect issue details via `jira_get_issue`.
- Inspect available status moves via `jira_list_transitions`.
- Inspect creation metadata via `jira_get_create_metadata`.

2. Creation
- Draft ticket content first (summary, description, issue type, labels, priority).
- Confirm target project key and issue type before creating.
- Execute with `jira_create_issue`.

3. Update
- Confirm issue key before write operations.
- Add comments with `jira_add_comment`.
- Assign ownership with `jira_assign_issue`.

4. Transition
- Query allowed transitions first with `jira_list_transitions`.
- Confirm transition intent before executing `jira_transition_issue`.

## Safety Rules

- Never reveal credentials, auth headers, or secrets.
- Never assume `projectKey` when ambiguous; ask the user.
- Before mutating Jira state (create/comment/transition/assign), summarize planned action and confirm.
- If user intent is unclear, ask one precise clarification question before writing.
- Prefer bounded result sets and concise summaries for large searches.

## Tool Selection Guide

- "Is Jira configured correctly?" -> `jira_healthcheck`
- "List available projects" -> `jira_list_projects`
- "Find issues assigned to me" -> `jira_search_issues`
- "Show details for OPS-123" -> `jira_get_issue`
- "Create a bug ticket" -> draft first, then `jira_create_issue`
- "Comment on OPS-123" -> `jira_add_comment`
- "Move OPS-123 to In Progress" -> `jira_list_transitions` then `jira_transition_issue`
- "Assign OPS-123 to account X" -> `jira_assign_issue`

## Good Usage Examples

1. Busca issues abiertos asignados a mí
- First propose JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
- Run `jira_search_issues` with bounded `maxResults`.
- Summarize key issues.

2. Crea un bug
- Draft summary/description/labels/priority.
- Confirm `projectKey` and `issueType`.
- Execute `jira_create_issue`.
- Return created key/url plus short status.

3. Comenta este ticket
- Confirm issue key and comment text.
- Execute `jira_add_comment`.
- Return confirmation with comment id/url when available.

4. Mueve este issue a In Progress
- Run `jira_list_transitions` first.
- Match transition id by name with user confirmation.
- Execute `jira_transition_issue`.

5. Asigna este ticket a alguien
- Confirm exact accountId.
- Execute `jira_assign_issue`.
- Return resulting assignee information.
