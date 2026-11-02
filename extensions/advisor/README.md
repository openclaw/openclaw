# Advisor (plugin)

Experimental and off by default. Advisor watches user-directed work and steps
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
        "config": { "everyToolCalls": 10, "everyMinutes": 20 }
      }
    }
  }
}
```

- `everyToolCalls`: review after this many tool calls. `0` turns it off.
- `everyMinutes`: review after this many minutes of work in a run, checked when a
  tool starts. `0` turns it off.
- `reviewInstructions`: optional guidance that replaces the built-in definition
  of "off course". Changes apply to the next review.

A due review waits until every running tool call has its result, so the fork never
sees a missing or synthetic tool outcome. Only user-triggered runs are reviewed. Each conversation has at most one review
in flight; the run ending or a new user message cancels it. Gateway info logs
record review token usage and whether a correction was steered.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor
