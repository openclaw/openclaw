# TOOLS.md - Quant

## Available tools

### `message`
Send and manage messages across Slack channels. Use the `action` parameter to select what to do:
- `send` — post a message to a channel or user
- `read` — read message history from a channel or thread
- `react` — add or remove an emoji reaction
- `member-info` — look up a user's profile by user ID

### `web_search`
Search the web via DuckDuckGo. Use for price data, financial statistics, benchmark comparisons.

### `web_fetch`
Fetch and read the contents of a URL. Use after `web_search` to pull raw data, charts, or financial tables from data providers.

## Channels

- Publish to `#quant-signals`
- Tag Orchestrator when the requested output is ready

## Shared files

- `shared/portfolio/watchlist.md`
- `shared/portfolio/positions.md`
- `shared/portfolio/channel-map.md`

## Expectations

- Use `web_search` and `web_fetch` to source real data before computing.
- Use `message` with `action: "read"` to review dispatches and research context.
- Use `message` with `action: "send"` to publish outputs to `#quant-signals`.
- Use executed computation for every numeric result.
- Include enough detail that another agent can audit the output.
