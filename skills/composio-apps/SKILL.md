---
name: composio-apps
description: Connected app tool recipes for Composio integrations (Gmail, Slack, GitHub, Notion, Google Calendar, Linear)
---

# Composio connected apps

Use **Composio tools** only. In DenchClaw these may already appear directly as tool names like `GMAIL_FETCH_EMAILS`; call those directly when present.

Do **not** use:
- `gog`
- shell CLIs for Gmail / Calendar / Drive / Slack / GitHub / Notion / Linear
- `curl`
- raw `/v1/composio/*` gateway calls
- direct Composio REST calls

If the user mentions Composio, rube, map, MCP, or says an app is already connected, Composio is the only allowed integration path. If the Composio tools are unavailable in the current session, stop and report repair guidance instead of bypassing them.

The workspace may contain `composio-tool-index.json` with the exact tool names and hints for **your** connected apps — prefer that file when present. If the exact tool is not obvious, call `composio_resolve_tool` first to get the correct tool name, argument shape, and default args.

## General rules

- Tool names are **uppercase** with underscores (e.g. `GMAIL_FETCH_EMAILS`).
- Pass **JSON-shaped** arguments as the tool schema requires: arrays are arrays, not comma-separated strings.
- If a call fails on argument shape, fix the types and retry once before escalating.
- Never fall back to `gog`, curl, or raw gateway HTTP for a connected app task unless the user explicitly asks for that non-Composio path.

## Gmail

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| List / read recent mail | `GMAIL_FETCH_EMAILS` | `label_ids`: `["INBOX"]`, `max_results`: `10` |
| Read one message | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `message_id` from list results |
| Send mail | `GMAIL_SEND_EMAIL` | `to`, `subject`, `body` (use schema field names) |

**Gotcha:** `label_ids` must be an array like `["INBOX"]`, never a single string.

## Slack

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| Send a message | `SLACK_SEND_MESSAGE` | `channel`, `text` |
| List channels / DMs | `SLACK_LIST_CONVERSATIONS` | Use schema filters if needed |

**Gotcha:** `channel` is usually a channel ID (often starts with `C`), not the display name.

## GitHub

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| List repos for user | `GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER` | Pagination per schema |
| Find / search pull requests | `GITHUB_FIND_PULL_REQUESTS` | Best first path for "recent PRs" or broad PR search |
| List pull requests in a repo | `GITHUB_LIST_PULL_REQUESTS` | Requires `owner` and `repo` |
| Get one pull request | `GITHUB_GET_A_PULL_REQUEST` | `owner`, `repo`, `pull_number` |
| Repo metadata | `GITHUB_GET_A_REPOSITORY` | `owner`, `repo` |
| Create issue | `GITHUB_CREATE_AN_ISSUE` | `owner`, `repo`, `title`, `body` |

## Notion

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| Search | `NOTION_SEARCH` | Query string per schema |
| Read page | `NOTION_GET_PAGE` | Page ID |
| Create page | `NOTION_CREATE_PAGE` | Parent object per schema |

## Google Calendar

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| List calendars | `GOOGLE_CALENDAR_CALENDAR_LIST` | Optional params per schema |
| Upcoming events | `GOOGLE_CALENDAR_EVENTS_LIST` | Prefer a clear time window when possible |
| List events | `GOOGLE_CALENDAR_EVENTS_LIST` | `calendar_id`, time range (`time_min` / `time_max` as RFC3339) |
| Find event | `GOOGLE_CALENDAR_EVENTS_LIST` | Use search text / date window fields supported by the schema |
| Create event | `GOOGLE_CALENDAR_CREATE_EVENT` | Calendar id + event payload per schema |

**Gotcha:** Datetimes should be RFC3339 strings.

## Linear

| Intent | Tool | Defaults / notes |
|--------|------|------------------|
| List issues | `LINEAR_LIST_ISSUES` | Filters per schema |
| Get issue | `LINEAR_GET_ISSUE` | Issue id |
| Create issue | `LINEAR_CREATE_ISSUE` | Team id, title, description per schema |

## Subagent handoff

When delegating, include: which app, the exact tool name, and the argument object you intend (copy shapes from the tool schema, `composio_resolve_tool`, or `composio-tool-index.json`).
