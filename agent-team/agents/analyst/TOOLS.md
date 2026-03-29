# TOOLS.md - Analyst

## Available tools

### `message`
Send and manage messages across Slack channels. Use the `action` parameter to select what to do:
- `send` — post a message to a channel or user
- `read` — read message history from a channel or thread
- `react` — add or remove an emoji reaction
- `member-info` — look up a user's profile by user ID

### `web_search`
Search the web via DuckDuckGo. Use for company research, financial data, industry reports, SEC filings.

### `web_fetch`
Fetch and read the contents of a URL. Use after `web_search` to read full articles, filings, earnings transcripts, or analyst reports.

## Channels

- Publish completed work to `#research`
- Tag Orchestrator when a deliverable is ready

## Shared files

- `shared/portfolio/watchlist.md`
- `shared/portfolio/recent-decisions.md`
- `shared/portfolio/channel-map.md`

## Expectations

- Use `web_search` and `web_fetch` to find and cite primary sources.
- Use `message` with `action: "read"` to review related signals in `#market-signals` before writing.
- Use `message` with `action: "send"` to publish research to `#research`.
- Default to primary sources first.
- Clearly separate sourced facts from inference.
