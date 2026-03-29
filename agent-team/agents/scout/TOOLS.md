# TOOLS.md - Scout

## Available tools

### `message`
Send and manage messages across Slack channels. Use the `action` parameter to select what to do:
- `send` — post a message to a channel or user
- `read` — read message history from a channel or thread
- `react` — add or remove an emoji reaction
- `member-info` — look up a user's profile by user ID

### `web_search`
Search the web via DuckDuckGo. Primary research tool for market signals, news, filings, macro events.

### `web_fetch`
Fetch and read the contents of a URL. Use after `web_search` to read full articles, SEC filings, earnings reports, or data pages.

## Channels

- Publish to `#market-signals`
- Tag Orchestrator for urgent alerts

## Shared files

- `shared/portfolio/watchlist.md`
- `shared/portfolio/channel-map.md`

## Expectations

- Use `web_search` and `web_fetch` to find and verify market signals before posting.
- Use `message` with `action: "send"` to post signals to `#market-signals`.
- Prioritize clear numeric comparisons against recent norms.
- Keep alerts short enough for rapid Slack review.
