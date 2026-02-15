# Feature: Slack Reader Tools

## Priority: 3

## Status: Spec Written

## Description

Read-only Slack tools that let Leo search and read messages across all 4 Slack
workspaces (saasgroup, protaige, edubites, zenloop). These tools are distinct
from OpenClaw's existing Slack channel integration (where Leo acts as a bot IN
Slack). The reader tools let Leo READ FROM Slack channels to gather conversation
context, search discussions, and understand channel activity.

The implementation follows OpenClaw's existing patterns:

- Uses `@slack/web-api` `WebClient` via `createSlackWebClient()` from `src/slack/client.ts`
- Uses the multi-account config pattern from `src/slack/accounts.ts`
- Registers as agent tools via the `AgentTool` interface from `@mariozechner/pi-agent-core`
- Uses `Type.Object` (typebox) for parameter schemas
- Uses `jsonResult()` from `src/agents/tools/common.ts` for return values

### Important Distinction

- **OpenClaw Slack channel** (`src/slack/monitor.ts`) = Leo as a bot that users message IN Slack
- **These tools** (`src/slack/reader/`) = Leo reading FROM Slack channels to gather context
- Both use Slack API but serve different purposes and use separate token resolution
- The reader tools resolve workspace tokens from config `tools.slackReader.workspaces`

## Acceptance Criteria

1. `slack_read` tool with `action=channels` and `workspace=zenloop` returns a list of channels with name, topic, and member count
2. `slack_read` tool with `action=history` returns recent messages with author display names resolved via Slack user info
3. `slack_read` tool with `action=search` and `workspace=all` searches across all 4 configured workspaces and merges results
4. `slack_read` tool with `action=thread` returns a full thread with all replies and resolved author names
5. `slack_read` tool with `action=summarize` fetches messages for the requested period and returns an LLM-generated summary
6. Invalid workspace name returns a clear error message listing valid workspaces
7. Missing or invalid bot token for a workspace returns a descriptive error (not a crash)
8. Channel resolution works by both name (e.g. `#general`) and Slack channel ID (e.g. `C1234ABC`)
9. Message count is clamped to a safe maximum (100) to prevent excessive API calls
10. The tool is gated by config `tools.slackReader.enabled` (default: false)

## Test Cases

| #   | Test                                | Input                                                                         | Expected Output                                                                     |
| --- | ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | List channels for workspace         | `action=channels, workspace=zenloop`                                          | Array of `{id, name, topic, memberCount}` objects                                   |
| 2   | List channels - invalid workspace   | `action=channels, workspace=invalid`                                          | Error: "Unknown workspace 'invalid'. Valid: saasgroup, protaige, edubites, zenloop" |
| 3   | Channel history - by name           | `action=history, workspace=edubites, channel=#general, count=10`              | Array of 10 messages with `{ts, text, author, threadTs?}`                           |
| 4   | Channel history - by ID             | `action=history, workspace=edubites, channel=C1234, count=5`                  | Array of messages (channel resolved by ID)                                          |
| 5   | Channel history - with since filter | `action=history, workspace=zenloop, channel=#eng, since=2026-02-14T00:00:00Z` | Messages only after the given timestamp                                             |
| 6   | Channel history - count clamped     | `action=history, workspace=zenloop, channel=#eng, count=500`                  | Count clamped to 100, returns up to 100 messages                                    |
| 7   | Search single workspace             | `action=search, workspace=zenloop, query=deployment`                          | Array of matching messages with `{channel, author, ts, text, permalink}`            |
| 8   | Search all workspaces               | `action=search, workspace=all, query=release`                                 | Merged results from all 4 workspaces, tagged with workspace name                    |
| 9   | Search - empty results              | `action=search, workspace=zenloop, query=xyznonexistent`                      | Empty array, no error                                                               |
| 10  | Thread fetch                        | `action=thread, workspace=zenloop, channel=#eng, threadTs=1707900000.000000`  | Array of thread messages including parent                                           |
| 11  | Thread fetch - invalid threadTs     | `action=thread, workspace=zenloop, channel=#eng, threadTs=invalid`            | Error from Slack API (propagated cleanly)                                           |
| 12  | Summarize channel                   | `action=summarize, workspace=zenloop, channel=#engineering, period=today`     | String summary with key discussions and action items                                |
| 13  | Summarize - no messages             | `action=summarize, workspace=zenloop, channel=#quiet, period=today`           | "No messages found in #quiet for today."                                            |
| 14  | Missing bot token                   | `action=channels, workspace=zenloop` (no token configured)                    | Error: "No bot token configured for workspace 'zenloop'"                            |
| 15  | Workspace token resolution          | Config has tokens for all 4 workspaces                                        | Each workspace uses its own token                                                   |
| 16  | Action gate - disabled              | `tools.slackReader.enabled=false`                                             | Tool not registered in tool list                                                    |

## Dependencies

- Feature 01 (People Index) -- for author resolution (graceful degradation: falls back to Slack display name if people index unavailable)
- Slack bot tokens with read-only scopes per workspace (manual prerequisite)
- `@slack/web-api` package (already in dependencies)

## Files

### New Files

- `src/slack/reader/client.ts` -- Workspace-aware client factory (resolves token per workspace from config)
- `src/slack/reader/channels.ts` -- `listReaderChannels()` function
- `src/slack/reader/history.ts` -- `readReaderHistory()` function
- `src/slack/reader/search.ts` -- `searchReaderMessages()` function
- `src/slack/reader/thread.ts` -- `readReaderThread()` function
- `src/slack/reader/summarize.ts` -- `summarizeReaderChannel()` function
- `src/slack/reader/types.ts` -- Shared types for reader tools
- `src/slack/reader/index.ts` -- Barrel export
- `src/agents/tools/slack-reader-tool.ts` -- Agent tool registration (single `slack_read` tool with action dispatch)
- `src/agents/tools/slack-reader-tool.test.ts` -- Unit tests for tool parameter handling and dispatch
- `src/slack/reader/client.test.ts` -- Tests for workspace client resolution
- `src/slack/reader/channels.test.ts` -- Tests for channel listing
- `src/slack/reader/history.test.ts` -- Tests for message history
- `src/slack/reader/search.test.ts` -- Tests for message search
- `src/slack/reader/thread.test.ts` -- Tests for thread fetching
- `src/slack/reader/summarize.test.ts` -- Tests for channel summarization

### Modified Files

- `src/agents/openclaw-tools.ts` -- Add `createSlackReaderTool()` to tool list
- `src/config/types.ts` (or relevant config type file) -- Add `SlackReaderConfig` type to tools config

## Notes

### Architecture: Single Tool with Action Dispatch

Following the pattern established by `src/agents/tools/slack-actions.ts`, the slack reader
implements a single `slack_read` tool with an `action` parameter that dispatches to the
appropriate handler. This keeps the tool surface area small (one tool instead of five).

Actions: `channels`, `history`, `search`, `thread`, `summarize`.

### Config Shape

```typescript
interface SlackReaderConfig {
  enabled?: boolean; // default: false
  workspaces?: Record<
    string,
    {
      botToken?: string;
      name?: string; // display label
      enabled?: boolean; // per-workspace toggle
    }
  >;
  maxCount?: number; // global max message count (default: 100)
}
```

Accessed via `config.tools.slackReader`.

### Workspace Token Resolution

Unlike the existing Slack channel integration which resolves tokens via `accounts`,
the reader tools resolve tokens from `tools.slackReader.workspaces`. This keeps the
reader configuration separate from the bot channel configuration.

### Summarize Implementation

The `summarize` action:

1. Fetches messages for the period using `conversations.history` with `oldest`/`latest` timestamps
2. Resolves author display names from Slack user info
3. Formats messages into a prompt
4. Calls the agent's LLM (via a callback or direct invocation) to generate a summary
5. Returns the summary text

For the initial implementation, `summarize` will format messages and return them with a
system instruction for the calling agent to summarize (rather than making a nested LLM call).
This avoids the complexity of nested LLM invocation from within a tool.

### Error Handling

- Unknown workspace: return error message listing valid workspaces
- Missing token: return descriptive error (not throw)
- Slack API errors: catch and return clean error object via `jsonResult`
- Invalid channel: let Slack API error propagate (channel_not_found)

### Message Format

Messages returned by `history`, `search`, and `thread` actions use a consistent shape:

```typescript
interface SlackReaderMessage {
  ts: string;
  text: string;
  author: string; // resolved display name
  authorId: string; // raw Slack user ID
  channel: string; // channel name
  channelId: string; // channel ID
  threadTs?: string; // if part of a thread
  replyCount?: number; // for parent messages
  workspace?: string; // included in search-all results
  permalink?: string; // if available from search
}
```

## Blocks

- Feature 07 (Briefings) -- Slack summaries needed for engineering digest
