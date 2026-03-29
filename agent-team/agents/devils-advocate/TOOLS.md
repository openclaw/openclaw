# TOOLS.md - Devil's Advocate

## Available tools

### `message`
Send and manage messages across Slack channels. Use the `action` parameter to select what to do:
- `send` — post a message to a channel or user
- `read` — read message history from a channel or thread
- `react` — add or remove an emoji reaction
- `member-info` — look up a user's profile by user ID

### `web_search`
Search the web via DuckDuckGo. Use for counter-evidence, bear cases, historical precedent, risk data.

### `web_fetch`
Fetch and read the contents of a URL. Use after `web_search` to read full articles, data, or historical case studies that challenge a thesis.

## Channels

- Publish to `#contrarian`
- Tag Orchestrator when a thesis review is ready

## Shared files

- `shared/portfolio/watchlist.md`
- `shared/portfolio/positions.md`
- `shared/portfolio/recent-decisions.md`
- `shared/portfolio/channel-map.md`

## Expectations

- Use `message` with `action: "read"` to review the thesis in `#research` and data in `#quant-signals` before writing.
- Use `web_search` and `web_fetch` to find counter-evidence and historical precedent.
- Use `message` with `action: "send"` to publish reviews to `#contrarian`.
- Attack assumptions, not personalities.
- Keep verdicts direct and evidence-backed.
