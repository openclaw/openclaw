# Advisor (plugin)

Experimental and off by default. Advisor watches user-directed work and steps
in while the agent goes off course: repeating failing steps, waiting on
finished work, working around a blocker it could fix, drifting beyond the
request, or claiming results the tools do not show.

By default a review forks the conversation on the session's own model and asks whether the
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

Cron- and heartbeat-rooted spawn chains and Workboard workers are not reviewed.
Direct chats and their subagents remain eligible. Advisor follows up to eight
session entries through `spawnedBy`; dashboard-only `parentSessionKey` links are
not spawn provenance. Isolated heartbeat metadata is also recognized. Missing entries and
lookup failures leave the run eligible. Scheduled work in a named session cannot
always be recognized from its key.

Current-turn provenance from `before_prompt_build` skips `sessions_send` reviews,
even after the input leaves the recent history window. When that provenance is
unavailable, Advisor checks the newest user message at review time. This includes
a human request relayed by another agent. The sending run remains
eligible. Admission requires session metadata reads, and each due review reads
up to 300 recent messages to inspect provenance.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor

## Optional review model

Set `config.model` to a `provider/model` reference to review through
`api.runtime.llm.complete` instead of the session-model fork. Optional
`config.thinking` selects the SDK reasoning effort and is ignored without a model.
Both settings are read again for each review.

Enable `plugins.entries.advisor.llm.allowModelOverride` and
`plugins.entries.advisor.llm.allowAgentIdOverride` for this path. The explicit
agent selection preserves the reviewed agent as the credential owner when the
service scheduler has no foreground invocation. Existing `allowedModels` and
`allowedCompletionModels` restrictions still apply. No policy is bypassed, and
Advisor does not set `requiredAuthMode`; credential selection remains host-owned.

The reviewer receives a transcript capped at 60,000 characters, including its
delimiters and omission notices. It retains a bounded copy of the current request,
the first user message available in the latest 300 messages, and the newest
entries that fit. Individual messages and tool outputs are clipped. This is not
the complete session context: original instructions, older constraints, tool
schemas and earlier messages may be absent. The current request is capped at
6,000 characters, so long requests may also be incomplete.

The chosen model gets a fresh text request without session prompt-cache reuse.
Cost and correction quality depend on that model and the shortened input; a
large reviewer may cost more than the default fork. There is no separate
verification stage for a proposed correction.

Policy refusals, provider errors and aborted completions skip the review and log
`review_model_failed (<model>)`; there is no fallback to the session model.
Timeouts retain the existing `timeout` log reason. Successful usage logs include
`model=<ref>`. Unset `model` keeps the existing session-model fork.
