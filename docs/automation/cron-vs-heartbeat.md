---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Guidance for choosing between heartbeat and cron jobs for automation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deciding how to schedule recurring tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up background monitoring or notifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Optimizing token usage for periodic checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Cron vs Heartbeat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Cron vs Heartbeat: When to Use Each（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Both heartbeats and cron jobs let you run tasks on a schedule. This guide helps you choose the right mechanism for your use case.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Decision Guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Use Case                             | Recommended         | Why                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------ | ------------------- | ---------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Check inbox every 30 min             | Heartbeat           | Batches with other checks, context-aware |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Send daily report at 9am sharp       | Cron (isolated)     | Exact timing needed                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Monitor calendar for upcoming events | Heartbeat           | Natural fit for periodic awareness       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Run weekly deep analysis             | Cron (isolated)     | Standalone task, can use different model |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Remind me in 20 minutes              | Cron (main, `--at`) | One-shot with precise timing             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Background project health check      | Heartbeat           | Piggybacks on existing cycle             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Heartbeat: Periodic Awareness（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeats run in the **main session** at a regular interval (default: 30 min). They're designed for the agent to check on things and surface anything important.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to use heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multiple periodic checks**: Instead of 5 separate cron jobs checking inbox, calendar, weather, notifications, and project status, a single heartbeat can batch all of these.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Context-aware decisions**: The agent has full main-session context, so it can make smart decisions about what's urgent vs. what can wait.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Conversational continuity**: Heartbeat runs share the same session, so the agent remembers recent conversations and can follow up naturally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Low-overhead monitoring**: One heartbeat replaces many small polling tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Heartbeat advantages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Batches multiple checks**: One agent turn can review inbox, calendar, and notifications together.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reduces API calls**: A single heartbeat is cheaper than 5 isolated cron jobs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Context-aware**: The agent knows what you've been working on and can prioritize accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Smart suppression**: If nothing needs attention, the agent replies `HEARTBEAT_OK` and no message is delivered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Natural timing**: Drifts slightly based on queue load, which is fine for most monitoring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Heartbeat example: HEARTBEAT.md checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Heartbeat checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check email for urgent messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Review calendar for events in next 2 hours（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a background task finished, summarize results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If idle for 8+ hours, send a brief check-in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent reads this on each heartbeat and handles all items in one turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configuring heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m", // interval（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last", // where to deliver alerts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        activeHours: { start: "08:00", end: "22:00" }, // optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Heartbeat](/gateway/heartbeat) for full configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron: Precise Scheduling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron jobs run at **exact times** and can run in isolated sessions without affecting main context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to use cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Exact timing required**: "Send this at 9:00 AM every Monday" (not "sometime around 9").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Standalone tasks**: Tasks that don't need conversational context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Different model/thinking**: Heavy analysis that warrants a more powerful model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **One-shot reminders**: "Remind me in 20 minutes" with `--at`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Noisy/frequent tasks**: Tasks that would clutter main session history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **External triggers**: Tasks that should run independently of whether the agent is otherwise active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cron advantages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Exact timing**: 5-field cron expressions with timezone support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session isolation**: Runs in `cron:<jobId>` without polluting main history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Model overrides**: Use a cheaper or more powerful model per job.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Delivery control**: Isolated jobs default to `announce` (summary); choose `none` as needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Immediate delivery**: Announce mode posts directly without waiting for heartbeat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No agent context needed**: Runs even if main session is idle or compacted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **One-shot support**: `--at` for precise future timestamps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cron example: Daily morning briefing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Morning briefing" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 7 * * *" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --tz "America/New_York" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model opus \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --channel whatsapp \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --to "+15551234567"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This runs at exactly 7:00 AM New York time, uses Opus for quality, and announces a summary directly to WhatsApp.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cron example: One-shot reminder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Meeting reminder" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --at "20m" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --system-event "Reminder: standup meeting starts in 10 minutes." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --wake now \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --delete-after-run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Cron jobs](/automation/cron-jobs) for full CLI reference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decision Flowchart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Does the task need to run at an EXACT time?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Does the task need isolation from main session?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use cron (isolated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Can this task be batched with other periodic checks?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use heartbeat (add to HEARTBEAT.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Use cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is this a one-shot reminder?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use cron with --at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Does it need a different model or thinking level?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use cron (isolated) with --model/--thinking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Use heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Combining Both（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The most efficient setup uses **both**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Heartbeat** handles routine monitoring (inbox, calendar, notifications) in one batched turn every 30 minutes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Cron** handles precise schedules (daily reports, weekly reviews) and one-shot reminders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example: Efficient automation setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**HEARTBEAT.md** (checked every 30 min):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Heartbeat checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scan inbox for urgent emails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check calendar for events in next 2h（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Review any pending tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Light check-in if quiet for 8+ hours（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Cron jobs** (precise timing):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Daily morning briefing at 7am（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Weekly project review on Mondays at 9am（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# One-shot reminder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Lobster: Deterministic workflows with approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster is the workflow runtime for **multi-step tool pipelines** that need deterministic execution and explicit approvals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use it when the task is more than a single agent turn, and you want a resumable workflow with human checkpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When Lobster fits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-step automation**: You need a fixed pipeline of tool calls, not a one-off prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approval gates**: Side effects should pause until you approve, then resume.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Resumable runs**: Continue a paused workflow without re-running earlier steps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How it pairs with heartbeat and cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Heartbeat/cron** decide _when_ a run happens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Lobster** defines _what steps_ happen once the run starts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For scheduled workflows, use cron or heartbeat to trigger an agent turn that calls Lobster.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For ad-hoc workflows, call Lobster directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Operational notes (from the code)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lobster runs as a **local subprocess** (`lobster` CLI) in tool mode and returns a **JSON envelope**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the tool returns `needs_approval`, you resume with a `resumeToken` and `approve` flag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The tool is an **optional plugin**; enable it additively via `tools.alsoAllow: ["lobster"]` (recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you pass `lobsterPath`, it must be an **absolute path**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Lobster](/tools/lobster) for full usage and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Main Session vs Isolated Session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Both heartbeat and cron can interact with the main session, but differently:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|         | Heartbeat                       | Cron (main)              | Cron (isolated)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------- | ------------------------------- | ------------------------ | -------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Session | Main                            | Main (via system event)  | `cron:<jobId>`             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| History | Shared                          | Shared                   | Fresh each run             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Context | Full                            | Full                     | None (starts clean)        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model   | Main session model              | Main session model       | Can override               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Output  | Delivered if not `HEARTBEAT_OK` | Heartbeat prompt + event | Announce summary (default) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to use main session cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--session main` with `--system-event` when you want:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The reminder/event to appear in main session context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The agent to handle it during the next heartbeat with full context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No separate isolated run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Check project" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --every "4h" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session main \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --system-event "Time for a project health check" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --wake now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to use isolated cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--session isolated` when you want:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A clean slate without prior context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different model or thinking settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Announce summaries directly to a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- History that doesn't clutter main session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron add \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name "Deep analysis" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cron "0 6 * * 0" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --session isolated \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --message "Weekly codebase analysis..." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model opus \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --thinking high \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --announce（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Considerations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Mechanism       | Cost Profile                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Heartbeat       | One turn every N minutes; scales with HEARTBEAT.md size |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Cron (main)     | Adds event to next heartbeat (no isolated turn)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Cron (isolated) | Full agent turn per job; can use cheaper model          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Tips**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep `HEARTBEAT.md` small to minimize token overhead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Batch similar checks into heartbeat instead of multiple cron jobs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `target: "none"` on heartbeat if you only want internal processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use isolated cron with a cheaper model for routine tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Heartbeat](/gateway/heartbeat) - full heartbeat configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Cron jobs](/automation/cron-jobs) - full cron CLI and API reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [System](/cli/system) - system events + heartbeat controls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
