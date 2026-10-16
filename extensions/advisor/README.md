# Advisor (plugin)

Experimental and off by default. Advisor watches user-directed work and steps
in when the agent goes off course: repeating failing steps, waiting on finished
work, stopping at a blocker it could fix, drifting beyond the request, or
claiming results the tools do not show.

A review forks the conversation on the session's own model and asks whether the
agent is on track. The reply is `NO_CHANGE` or `CORRECTION` followed by one
short correction. A correction steers the active run. If the run already ended,
Advisor starts a follow-up turn so the agent acts on it right away.

Reviews run when a trigger is due and once at the end of each run that used
tools:

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

Only user-triggered runs are reviewed, so follow-up turns are never reviewed
again. Each conversation has at most one review in flight; a new user message or
an aborted run cancels it. Gateway info logs record review token usage and
whether a correction was steered or started a follow-up turn.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor
