---
name: dench-integrations
description: Connected app integration recipes for Dench Integrations (Gmail, Slack, GitHub, Notion, Google Calendar, Linear, Stripe, YouTube, and 500+ more)
---

# Dench Integrations

Use the **Dench Integrations tools** for all connected third-party app tasks in DenchClaw.

## Two tools only

1. **`dench_search_integrations`** — Search for available integration tools by query and/or toolkit slug. Returns tool slugs, descriptions, full `input_schema`, connection status, and connected accounts.
2. **`dench_execute_integrations`** — Execute a tool by its `tool_slug` with `arguments` matching the `input_schema`. The gateway handles authentication and account selection automatically when only one account is connected.

## Workflow

1. Call `dench_search_integrations` with a query with EXACT search strings of what might help you find relevant tools. like "posthog project", "stripe subscription", etc. (optionally narrow with toolkit).
2. Inspect the returned `results` — each has `tool_slug`, `input_schema`, `is_connected`, `account_count`, and `accounts`.
3. Read the `input_schema` to understand required fields, types, and defaults.
4. Call `dench_execute_integrations` with `tool_slug` and the correct `arguments`.

Do **not** use:
- `gog`, shell CLIs for Gmail / Calendar / Drive / Slack / GitHub / Notion / Linear (unless you need to as last resort or if explicitly asked)
- `curl` or raw gateway HTTP calls (unless explicitly asked)
- Direct provider REST calls (unless explicitly asked)

## Multi-account handling

When `dench_search_integrations` shows `account_count > 1` for a toolkit:
1. The `accounts` array lists each connected account with `connected_account_id`, `label`, and `email`.
2. Ask the user which account they want to use.
3. Pass the chosen `connected_account_id` to `dench_execute_integrations`.

When only one account is connected, the gateway auto-selects it — no `connected_account_id` needed.

## Execute examples

### Gmail — fetch recent emails

```json
{
  "tool_slug": "GMAIL_FETCH_EMAILS",
  "arguments": {
    "label_ids": ["INBOX"],
    "max_results": 10
  }
}
```

### Slack — send a message

```json
{
  "tool_slug": "SLACK_SEND_MESSAGE",
  "arguments": {
    "channel": "C01ABCDEF",
    "text": "Hello from DenchClaw!"
  }
}
```

### GitHub — list pull requests

```json
{
  "tool_slug": "GITHUB_LIST_PULL_REQUESTS",
  "arguments": {
    "owner": "DenchHQ",
    "repo": "denchclaw",
    "state": "open"
  }
}
```

### Stripe — list subscriptions

```json
{
  "tool_slug": "STRIPE_LIST_SUBSCRIPTIONS",
  "arguments": {
    "limit": 100
  }
}
```

### YouTube — list subscriptions

```json
{
  "tool_slug": "YOUTUBE_LIST_USER_SUBSCRIPTIONS",
  "arguments": {
    "part": "snippet",
    "max_results": 50
  }
}
```

### With explicit account selection

```json
{
  "tool_slug": "GMAIL_SEND_EMAIL",
  "arguments": {
    "to": "user@example.com",
    "subject": "Hello",
    "body": "Test email"
  },
  "connected_account_id": "abc123-def456"
}
```

## General rules

- Tool names are **uppercase** with underscores (e.g. `GMAIL_FETCH_EMAILS`).
- Pass **JSON-shaped** arguments as the tool schema requires: arrays are arrays, not comma-separated strings.
- Read the returned `input_schema` before filling arguments. Use exact field names and types.
- Treat the live schema from `dench_search_integrations` as authoritative over any recipe table below.
- If a call fails on argument shape, fix the types and retry once before escalating.
- If the search returns `availability: "connect_required"`, show the connect link to the user.
- If the response includes pagination fields (`has_more`, `next_cursor`, `starting_after`, etc.), keep paginating when the user asked for the full dataset.

## Quick recipe tables

### Gmail

| Intent | Tool | Key arguments |
|--------|------|---------------|
| List recent mail | `GMAIL_FETCH_EMAILS` | `label_ids`: `["INBOX"]`, `max_results`: `10` |
| Read one message | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `message_id` from list results |
| Send mail | `GMAIL_SEND_EMAIL` | `to`, `subject`, `body` |

**Gotcha:** `label_ids` must be an array like `["INBOX"]`, never a single string.

### Slack

| Intent | Tool | Key arguments |
|--------|------|---------------|
| Send a message | `SLACK_SEND_MESSAGE` | `channel`, `text` |
| List channels | `SLACK_LIST_CONVERSATIONS` | Use schema filters |

**Gotcha:** `channel` is usually a channel ID (starts with `C`), not the display name.

### GitHub

| Intent | Tool | Key arguments |
|--------|------|---------------|
| List repos | `GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER` | Pagination per schema |
| Find pull requests | `GITHUB_FIND_PULL_REQUESTS` | Best for broad PR search |
| List pull requests | `GITHUB_LIST_PULL_REQUESTS` | `owner`, `repo` |
| Create issue | `GITHUB_CREATE_AN_ISSUE` | `owner`, `repo`, `title`, `body` |

### Notion

| Intent | Tool | Key arguments |
|--------|------|---------------|
| Search | `NOTION_SEARCH` | Query string |
| Read page | `NOTION_GET_PAGE` | Page ID |
| Create page | `NOTION_CREATE_PAGE` | Parent object per schema |

### Google Calendar

| Intent | Tool | Key arguments |
|--------|------|---------------|
| List calendars | `GOOGLE_CALENDAR_CALENDAR_LIST` | Optional params |
| List events | `GOOGLE_CALENDAR_EVENTS_LIST` | `calendar_id`, `time_min`/`time_max` (RFC3339) |
| Create event | `GOOGLE_CALENDAR_CREATE_EVENT` | Calendar id + event payload |

**Gotcha:** Datetimes should be RFC3339 strings.

### Linear

| Intent | Tool | Key arguments |
|--------|------|---------------|
| List issues | `LINEAR_LIST_ISSUES` | Filters per schema |
| Create issue | `LINEAR_CREATE_ISSUE` | Team id, title, description |

### Stripe

| Intent | Tool | Key arguments |
|--------|------|---------------|
| List subscriptions | `STRIPE_LIST_SUBSCRIPTIONS` | Use schema filters |
| Search subscriptions | `STRIPE_SEARCH_SUBSCRIPTIONS` | Customer or filter-specific |
| List customers | `STRIPE_LIST_CUSTOMERS` | For customer lookup |
| Retrieve balance | `STRIPE_RETRIEVE_BALANCE` | Current balance snapshot |

## Subagent handoff

When delegating, include: the `tool_slug`, the `arguments` object (copy shapes from the live `input_schema` returned by `dench_search_integrations`), and if applicable the `connected_account_id`.
