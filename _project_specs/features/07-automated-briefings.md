# Feature: Automated Briefings

## Priority: 4 (Capstone)

## Status: Spec Written

## Description

Cron-driven automated summaries that Leo pushes to the user. Three tools aggregate
data from all other features (01-06) into actionable briefings. The morning briefing
covers today's calendar, email, tickets, PRs, and Slack highlights. The weekly
engineering recap summarizes a full week of shipped work, sprint progress, blockers,
and team activity. A configure tool lets the user customize sections and delivery.

All data collection is done by calling existing tools from features 01-06 via the
gateway. The briefing tools compose results into a formatted summary. Scheduled
delivery uses OpenClaw's cron system (`cron.add` with `agentTurn` payload).

## User Stories

- As a user, I receive a morning briefing at 8am with my day's overview
- As a user, I receive a weekly engineering recap on Friday afternoon
- As a user, I can ask "give me my briefing" anytime for an on-demand summary
- As a user, I can customize what's included in each briefing type

## Tools to Implement

### `briefing.morning`

- **Parameters:** `date` (optional ISO date string, defaults to today)
- **Returns:** Formatted morning briefing text with sections
- **Behavior:**
  1. Load briefing config to determine enabled sections
  2. For each enabled section, call the corresponding tool via gateway:
     - `calendar` -> `calendar.today` with `org=all`
     - `email` -> `gmail.triage` with `org=all`
     - `tickets` -> `asana.tasks` with `status=in_progress` + `monday.items`
     - `prs` -> `github.prs` with `org=protaige` + `org=zenloop`, `state=open`
     - `slack` -> `slack_read.summarize` with `period=today` for key channels
  3. Each section call is wrapped in error handling (skip on failure, note it)
  4. Format all section results into a single briefing string
  5. Return the formatted briefing

### `briefing.weekly`

- **Parameters:** `week_start` (optional ISO date string, defaults to current week Monday)
- **Returns:** Formatted weekly engineering recap text
- **Behavior:**
  1. Load briefing config to determine enabled sections
  2. Calculate week date range (Monday through Friday)
  3. For each enabled section, call the corresponding tool:
     - `shipped` -> `github.prs` with `state=merged` + date range
     - `in_progress` -> `asana.sprint_status`
     - `blocked` -> `asana.tasks` with `status=blocked`
     - `discussions` -> `slack_read.summarize` with `period=this_week`
     - `numbers` -> `github.commits` since week start + PR counts
     - `people` -> Derived from PR authors + task assignees via `people.search`
  4. Each section call is wrapped in error handling
  5. Format all section results into a single recap string
  6. Return the formatted recap

### `briefing.configure`

- **Parameters:**
  - `type` (required enum: `morning` | `weekly`)
  - `sections` (optional string array: sections to enable)
  - `delivery_channel` (optional enum: `whatsapp` | `slack` | `both`)
  - `schedule` (optional string: cron expression for delivery time)
  - `enabled` (optional boolean: enable or disable this briefing type)
- **Returns:** Updated briefing config object
- **Behavior:**
  1. Read current briefing config from storage
  2. Merge provided params into existing config
  3. If schedule changed and briefing is enabled, update the cron job
  4. Save updated config
  5. Return the new config

## Briefing Config Schema

```typescript
interface BriefingConfig {
  morning: {
    enabled: boolean;
    schedule: string; // cron expression, default "0 8 * * 1-5"
    delivery_channel: string; // "whatsapp" | "slack" | "both"
    sections: string[]; // ["calendar", "email", "tickets", "prs", "slack"]
  };
  weekly: {
    enabled: boolean;
    schedule: string; // cron expression, default "0 16 * * 5"
    delivery_channel: string;
    sections: string[]; // ["shipped", "in_progress", "blocked", "discussions", "numbers", "people"]
  };
}
```

Default config is used when no custom config exists in storage.

## Cron Integration

Scheduled briefings use OpenClaw's cron tool with `agentTurn` payloads:

- Morning: `{ kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Berlin" }`
- Weekly: `{ kind: "cron", expr: "0 16 * * 5", tz: "Europe/Berlin" }`

The `briefing.configure` tool manages cron jobs. When a briefing schedule is
updated, the old cron job is removed and a new one is created with the updated
schedule. The cron payload calls `briefing.morning` or `briefing.weekly`.

## Section Formatting

Each section produces a text block:

```
## Calendar (3 meetings today)
- 09:00-09:30  Standup (zenloop)
- 11:00-12:00  Product sync (edubites)
- 14:00-14:30  1:1 with Verena (zenloop)
Gap: 12:00-14:00 (2h free)
```

Failed sections produce:

```
## Email
[Unable to fetch email data - Gmail API unavailable]
```

## Acceptance Criteria

1. `briefing.morning` returns a formatted string with all enabled sections populated from real tool data
2. `briefing.morning` with a failed dependency tool still returns a briefing with remaining sections and a note for the failed section
3. `briefing.weekly` returns a formatted string aggregating a full week of engineering data
4. `briefing.weekly` calculates the correct week range (Monday-Friday) from the optional `week_start` param
5. `briefing.configure type=morning sections=["calendar","prs"]` updates config to only include those 2 sections
6. `briefing.configure type=morning enabled=false` disables the morning briefing
7. `briefing.configure type=weekly schedule="0 17 * * 5"` updates the weekly cron schedule
8. `briefing.morning` with `sections=["calendar"]` only includes the calendar section
9. `briefing.morning` with `date=<specific-date>` passes that date to calendar.today
10. `briefing.weekly` with `week_start=<date>` uses that date range instead of current week
11. Default briefing config is used when no custom config exists

## Test Cases

| #   | Test                                 | Input                                                         | Expected Output                                                                   |
| --- | ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Morning briefing all sections        | `briefing.morning` (default config)                           | Formatted string with calendar, email, tickets, prs, slack sections               |
| 2   | Morning briefing custom date         | `briefing.morning date="2026-02-16"`                          | Briefing with data for Feb 16                                                     |
| 3   | Morning briefing partial failure     | One tool call throws error                                    | Briefing with 4 sections + 1 error note                                           |
| 4   | Morning briefing all failures        | All tool calls throw errors                                   | Briefing with 5 error notes, no crash                                             |
| 5   | Weekly recap all sections            | `briefing.weekly` (default config)                            | Formatted string with shipped, in_progress, blocked, discussions, numbers, people |
| 6   | Weekly recap custom week             | `briefing.weekly week_start="2026-02-09"`                     | Data for Feb 9-13 week                                                            |
| 7   | Weekly recap partial failure         | Two tools fail                                                | Recap with 4 sections + 2 error notes                                             |
| 8   | Configure enable sections            | `briefing.configure type=morning sections=["calendar","prs"]` | Config updated, only 2 sections                                                   |
| 9   | Configure disable briefing           | `briefing.configure type=morning enabled=false`               | morning.enabled = false                                                           |
| 10  | Configure update schedule            | `briefing.configure type=weekly schedule="0 17 * * 5"`        | Schedule updated in config                                                        |
| 11  | Configure delivery channel           | `briefing.configure type=morning delivery_channel="slack"`    | Channel updated                                                                   |
| 12  | Filtered morning briefing            | Config has sections=["calendar","email"]                      | Only calendar and email in output                                                 |
| 13  | Default config fallback              | No config in storage                                          | Default config used with all sections                                             |
| 14  | Morning sections have correct labels | `briefing.morning`                                            | Each section has a markdown header                                                |
| 15  | Weekly date range calculation        | `briefing.weekly` called on Wednesday                         | week_start resolves to Monday                                                     |

## Dependencies

- Feature 01 (People Index) -- for name resolution in summaries (`people.search`)
- Feature 02 (Gmail) -- email triage data (`gmail.triage`)
- Feature 03 (Calendar) -- today's events (`calendar.today`)
- Feature 04 (Slack Reader) -- channel summaries (`slack_read.summarize`)
- Feature 05 (Asana) -- sprint/task data (`asana.tasks`, `asana.sprint_status`)
- Feature 06 (GitHub + Monday) -- PR and board data (`github.prs`, `github.commits`, `monday.items`)

## Files

- `src/agents/tools/briefing-tool.ts` -- Main briefing tool (morning, weekly, configure)
- `src/agents/tools/briefing-tool.test.ts` -- Unit tests
- `src/agents/tools/briefing-sections.ts` -- Section data fetchers (one function per section)
- `src/agents/tools/briefing-format.ts` -- Section formatters (data -> markdown text)
- `src/agents/tools/briefing-config.ts` -- Config storage (read/write briefing config)

## Notes

- This is the CAPSTONE feature -- it depends on ALL features 01-06
- All external data comes through existing tools (no direct API calls)
- Error handling is critical: any dependency tool can fail, and the briefing must still render
- The briefing tool itself does NOT call LLMs for summarization; it formats structured data from tools that already do summarization (e.g., `slack_read.summarize`)
- Cron scheduling uses the existing `cron-tool.ts` patterns (`callGatewayTool`)
- Config is stored via the gateway memory system (similar to how other tools persist settings)
