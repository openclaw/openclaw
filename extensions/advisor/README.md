# Advisor (plugin)

Off by default. Advisor watches user-directed work and steps
in while the agent goes off course: repeating failing steps, waiting on
finished work, working around a blocker it could fix, drifting beyond the
request, or claiming results the tools do not show.

A review forks the conversation on the session's own model and asks whether the
agent is on track. The reply is `NO_CHANGE` or `CORRECTION` followed by one
short correction, which steers the active run under its own permissions. If the
run already ended, the correction is dropped. Reviews run when a trigger is due:

```json
{
  "plugins": {
    "entries": {
      "advisor": {
        "enabled": true,
        "config": { "everyMinutes": 20, "everyToolCalls": 0 }
      }
    }
  }
}
```

- `everyMinutes` (default `20`): review after this many minutes of work in a run,
  checked when a tool starts. `0` turns it off.
- `everyToolCalls` (default `0`, off): also review after this many tool calls.
- `reviewInstructions`: optional guidance that replaces the built-in definition
  of "off course". Changes apply to the next review.

A due review waits until every running tool call has its result, so the fork never
sees a missing or synthetic tool outcome. Only the main agent's user-triggered runs
are reviewed; subagent sessions are not, because the main agent sees their results
and can redirect them. A later review in the same run is told the correction it
already gave and does not repeat it. Each conversation has at most one review
in flight; the run ending or a new user message cancels it. Gateway info logs
record review token usage and whether a correction was steered.

Docs: https://docs.openclaw.ai/plugins/reference/advisor
