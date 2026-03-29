# Jira Cloud Plugin (Bundled)

`extensions/jira-cloud` is a bundled/internal OpenClaw plugin that provides a real Jira Cloud runtime integration plus a Jira workflow skill.

## Packaging and Availability

- Package name: `@openclaw/jira-cloud`
- Current state: `"private": true` in this repo
- Distribution: bundled/internal (not documented as a public npm install flow)

## Configuration

Configure under `plugins.entries.jira-cloud.config`:

```json
{
  "plugins": {
    "entries": {
      "jira-cloud": {
        "enabled": true,
        "config": {
          "siteUrl": "https://your-org.atlassian.net",
          "email": "bot@your-org.com",
          "apiToken": "your-atlassian-api-token",
          "defaultProjectKey": "OPS",
          "defaultIssueType": "Task",
          "requestTimeoutMs": 15000,
          "retryCount": 2
        }
      }
    }
  }
}
```

Required:
- `siteUrl` (or `baseUrl`) must be an HTTPS Jira Cloud URL (`*.atlassian.net`)
- `email`
- `apiToken`

Optional:
- `defaultProjectKey`
- `defaultIssueType`
- `requestTimeoutMs`
- `retryCount`
- `userAgent`

Environment fallback is supported:
- `JIRA_CLOUD_SITE_URL`
- `JIRA_CLOUD_EMAIL`
- `JIRA_CLOUD_API_TOKEN`
- `JIRA_CLOUD_REQUEST_TIMEOUT_MS`
- `JIRA_CLOUD_RETRY_COUNT`
- `JIRA_CLOUD_USER_AGENT`

## Tools Exposed

The plugin registers these tools:

1. `jira_healthcheck`
2. `jira_list_projects`
3. `jira_search_issues`
4. `jira_get_issue`
5. `jira_create_issue`
6. `jira_add_comment`
7. `jira_list_transitions`
8. `jira_transition_issue`
9. `jira_assign_issue`
10. `jira_get_create_metadata`

## Supported Operations

- Validate Jira connectivity/authentication.
- List accessible projects.
- Search issues with JQL.
- Read issue details.
- Create issues.
- Add comments.
- List transitions.
- Transition issues.
- Assign issues.
- Fetch minimal create metadata.

## Security and Hardening

- Fail-closed when required credentials are missing.
- API token is never intentionally returned in tool output.
- Error normalization sanitizes secrets.
- Timeout and conservative retry logic for 429/5xx/transient failures.
- Tool input validation for keys, required fields, and bounded result sizes.
- Field selection is allowlisted for search/detail tools.

## Known Limits

- Metadata endpoints differ across Jira Cloud tenants; this plugin uses a conservative subset and returns best-effort metadata.
- Custom fields are not fully modeled by static types and are returned as generic field payloads where needed.
- Issue description/comment bodies are sent as plain-text ADF documents.
