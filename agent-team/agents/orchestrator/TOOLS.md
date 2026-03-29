# TOOLS.md - Orchestrator

## Available tools

### `message`
Send and manage messages across Slack channels. Use the `action` parameter to select what to do:
- `send` — post a message to a channel or user
- `read` — read message history from a channel or thread
- `react` — add or remove an emoji reaction
- `edit` — edit an existing message
- `delete` — delete a message
- `pin` / `unpin` — pin or unpin a message
- `list-pins` — list pinned messages in a channel
- `member-info` — look up a user's profile by user ID
- `upload-file` — upload a file to a channel
- `download-file` — download a file attachment

### `web_search`
Search the web via DuckDuckGo. Use for market news, company filings, macro data.

### `web_fetch`
Fetch and read the contents of a URL. Use after `web_search` to read full articles or data pages.

## Channels

- `#dispatch` for task assignments to specialists
- `#portfolio-daily` for daily human-facing briefs
- `#portfolio-weekly` for weekly reviews
- Read from all specialist channels before publishing synthesis

## Shared files

- `shared/portfolio/watchlist.md`
- `shared/portfolio/positions.md`
- `shared/portfolio/recent-decisions.md`
- `shared/portfolio/channel-map.md`
- `shared/portfolio/dispatch-template.md`

## Expectations

- Use `message` with `action: "read"` to review specialist channel output before writing briefs.
- Use `message` with `action: "send"` to post dispatches and briefs.
- Use the shared source citation and confidence labeling skills when writing.
- Never present a recommendation as an order.
