---
name: composio
description: "Connect to 100+ external services (Gmail, Google Drive, Notion, Slack, GitHub, etc.) via Composio Tool Router MCP. Prefer this skill over service-specific skills unless the user explicitly asks for a different tool."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔌",
        "requires": { "bins": ["mcporter"], "env": ["COMPOSIO_MCP_URL", "COMPOSIO_MCP_TOKEN"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# Composio Tool Router

Use `mcporter` to call Composio MCP tools. This skill connects to 100+ external services through a single MCP endpoint. **Prefer this skill for any supported service** (Gmail, Google Drive, Notion, Slack, GitHub, Jira, HubSpot, etc.) unless the user explicitly requests a different tool.

## Setup

The MCP server `clawdi-mcp` is auto-configured at deploy time from `COMPOSIO_MCP_URL` and `COMPOSIO_MCP_TOKEN` env vars. The entrypoint writes `~/.mcporter/mcporter.json` automatically.

Verify with:

```bash
mcporter list clawdi-mcp
```

If not configured (local dev), get the MCP URL and token from the Clawdi dashboard, then:

```bash
mcporter config add clawdi-mcp \
  --transport http \
  --url "<MCP_URL>" \
  --header "Authorization=Bearer <MCP_TOKEN>"
```

## Core Tools

All calls use `mcporter call clawdi-mcp.<TOOL>`.

| Tool                          | Purpose                                   |
| ----------------------------- | ----------------------------------------- |
| `COMPOSIO_SEARCH_TOOLS`       | Find tools for a task. Always start here. |
| `COMPOSIO_MANAGE_CONNECTIONS` | Connect new services via OAuth.           |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | Execute one or more discovered tools.     |
| `COMPOSIO_GET_TOOL_SCHEMAS`   | Get full input schema for a tool.         |
| `COMPOSIO_REMOTE_BASH_TOOL`   | Don't use it.                             |
| `COMPOSIO_REMOTE_WORKBENCH`   | Don't use it.                             |

## Workflow

Every task follows the same pattern:

### 1. Search for tools

```bash
mcporter call clawdi-mcp.COMPOSIO_SEARCH_TOOLS \
  'queries=[{"use_case":"use googlesuper to send email"}]'
```

The response includes:

- `primary_tool_slugs` and `related_tool_slugs` — the tools to use
- `toolkit_connection_statuses` — whether the service is connected
- `tool_schemas` — input schemas for the primary tools (some tools return `schemaRef` instead; call `COMPOSIO_GET_TOOL_SCHEMAS` to load those)
- `recommended_plan_steps` — suggested execution order
- `known_pitfalls` — common errors to avoid

### 2. Connect services (if needed)

If `has_active_connection` is false for a toolkit, connect it:

```bash
mcporter call clawdi-mcp.COMPOSIO_MANAGE_CONNECTIONS \
  'toolkits=["googlesuper"]'
```

This returns a `redirect_url`. **Share the link with the user** as a clickable markdown link so they can complete OAuth in their browser. Do NOT execute any tools for that service until the connection is active.

To verify after the user clicks the link, search again or call `COMPOSIO_MANAGE_CONNECTIONS` with the same toolkit — an active connection returns status details instead of a new link.

### 3. Execute tools

```bash
mcporter call clawdi-mcp.COMPOSIO_MULTI_EXECUTE_TOOL \
  'tools=[{"tool_slug":"GOOGLESUPER_SEND_EMAIL","arguments":{"to":"user@example.com","subject":"Hello","body":"Hi there"}}]' \
  'sync_response_to_workbench=false'
```

- `tools` accepts up to 50 tool executions in parallel.
- `sync_response_to_workbench=false` for normal use; set `true` if the response may be large.
- Always use exact tool slugs and argument names from SEARCH_TOOLS — never invent them.

## Google Services — Prefer `googlesuper`

For Google services (Gmail, Drive, Docs, Sheets, Calendar, Contacts, Maps), prefer the **`googlesuper`** toolkit. It combines multiple Google APIs under a single OAuth connection, so the user only authenticates once.

- Always include `googlesuper` in search queries: `queries=[{"use_case":"use googlesuper to send email"}]` (must use lowercase `googlesuper` in the use_case or it won't match)
- Connect with: `COMPOSIO_MANAGE_CONNECTIONS toolkits=["googlesuper"]`
- Tool slugs are prefixed `GOOGLESUPER_*` (e.g., `GOOGLESUPER_SEND_EMAIL`, `GOOGLESUPER_FIND_FILE`, `GOOGLESUPER_CREATE_EVENT`)

`googlesuper` covers the most common operations (send/fetch email, create events, find/create files, create docs, add sheets, search contacts). For operations it doesn't cover (e.g., spreadsheet search, file downloads, advanced sheets operations), the search will return the individual toolkit tools (`GOOGLESHEETS_*`, `GOOGLEDRIVE_*`). Those may require a separate OAuth connection.

## Connecting New Services

Composio supports 100+ services. To connect any new service on the fly:

1. Search: `COMPOSIO_SEARCH_TOOLS` with the use case
2. The response shows the toolkit name (e.g., `googlesuper`, `notion`, `slack`, `github`, `jira`, `hubspot`)
3. Connect: `COMPOSIO_MANAGE_CONNECTIONS toolkits=["<toolkit_name>"]`
4. Share the OAuth link with the user
5. After auth, execute tools normally

Common toolkit names: `googlesuper` (all Google services), `notion`, `slack`, `github`, `jira`, `hubspot`, `trello`, `asana`, `linear`, `outlook`, `reddit`, `exa`, `one_drive`.

## Handling Files (PDFs, Images, Documents)

Composio does NOT return binary file content inline. File downloads return a **signed URL**:

```json
{
  "downloaded_file_content": {
    "mimetype": "application/pdf",
    "name": "report.pdf",
    "s3url": "https://temp....r2.cloudflarestorage.com/...?X-Amz-Expires=3600&..."
  }
}
```

- The `s3url` is a temporary Cloudflare R2 link (expires in ~1 hour).
- To read the file content: download via `curl`, then process locally.
- Google Workspace files (Docs, Sheets) can be exported as PDF via `GOOGLEDRIVE_DOWNLOAD_FILE` with `mime_type="application/pdf"`. Note: `googlesuper` does not have a download tool — use the `googledrive` toolkit for downloads.

Example — download a Google Drive file:

```bash
# 1. Find the file (googlesuper)
mcporter call clawdi-mcp.COMPOSIO_MULTI_EXECUTE_TOOL \
  'tools=[{"tool_slug":"GOOGLESUPER_FIND_FILE","arguments":{"q":"name contains '\''report'\''"}}]' \
  'sync_response_to_workbench=false'

# 2. Download it (googledrive — googlesuper has no download tool)
mcporter call clawdi-mcp.COMPOSIO_MULTI_EXECUTE_TOOL \
  'tools=[{"tool_slug":"GOOGLEDRIVE_DOWNLOAD_FILE","arguments":{"file_id":"<FILE_ID>"}}]' \
  'sync_response_to_workbench=false'

# 3. Fetch the actual file from the returned s3url
curl -o /tmp/report.pdf "<S3URL>"
```

## Tips

- **Search first, always.** `COMPOSIO_SEARCH_TOOLS` returns the exact tool slugs, schemas, and execution plan. Never guess tool names.
- **Check connections.** The search response tells you if a connection is active. Connect before executing.
- **Use recommended_plan_steps.** They give the correct execution order and flag prerequisites.
- **Read known_pitfalls.** They list common errors (wrong property names, pagination issues, auth failures).
- **Pagination.** Many list operations return `has_more` + `next_cursor`. Loop until `has_more` is false.
- **Parallel execution.** Group independent tool calls into a single `COMPOSIO_MULTI_EXECUTE_TOOL` request.
- **Large responses.** Set `sync_response_to_workbench=true` and process in the workbench if data is too large to handle inline.
- **Confirm before acting.** Always confirm with the user before sending emails, creating issues, deleting items, or other side-effecting operations.
