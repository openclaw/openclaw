# Advisor (plugin)

Experimental and off by default. During user-directed work, Advisor reviews a
fork of the conversation on the session's own model. When it finds avoidable
work, such as drifting beyond the request or redundant tool calls, a second fork
checks the draft correction before any steering. Only approved advice reaches
the active run. Reviews preserve user-requested repetition,
waiting, ordering, and timing; uncertain cases receive no correction. Corrections
aim to fix the cause and resume useful work, not just stop at a recoverable
blocker. If the run cannot accept steering, the correction becomes hidden context
on the next turn and expires after 24 hours.

Review replies must start with `NO_CHANGE` or `CORRECTION` on its own line.
`NO_CHANGE` never starts verification or steering, even with commentary. A draft
correction is checked against the same session by a verifier, which replies
`APPROVE` with the final advice or `REJECT`. Only the approved body is delivered.
Both steps share a 120-second deadline. Advice is limited to 120 words and each
reply to 2,000 characters. Reserved decision words are not allowed as whole tokens
anywhere in either reply's body, including inline or next to punctuation.
Malformed replies, verification errors, and timeouts never steer; parser failures
log a bounded reason, and other failures log only a fixed category.

Enable it in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page. Or use config:

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

Only user-triggered runs count. Advisor admits them through the history-free
`before_agent_reply` hook without claiming the reply. Manual compaction,
heartbeat, cron, memory-flush, overflow, side-question, and missing or
unrecognized triggers do not count.

`everyToolCalls` counts tool calls as they start, including commands that are
still running in the background and calls from channel-originated user runs.
Accounting begins at the lifecycle start event, not at admission; events before
that start do not count. `everyMinutes` counts accumulated agent run time from
that start, including model work before the first tool call, checked as tools
start, finish, and when a run ends. Either trigger marks a review due; `0` disables
a trigger. The review waits until all started tool calls have authoritative
completion events, or the run ends or errors. Built-in runs settle on tool
results. Codex tracks native tool-item starts through completion and raw call
receipts through their recorded outputs, including outer function and custom/code-mode
calls. Child command completion does not settle an enclosing call. Early dynamic
tool results never release that work. Both the initial review and verification
recheck settlement immediately before forking; new calls can delay verification.

Stalled calls never force a review. A due review waits for tool settlement or
run end; reviewing at run end preserves feedback when no next model call occurs.
Lifecycle end/error clears pending tool IDs. Both counters restart when a review
completes, including a failed review, so the next review waits a full interval.

The event subscription requests metadata only for tool starts/results, Codex
native and raw item starts/completions, and lifecycle starts/ends/errors, without copying tool
result payloads. Ignored phases are rejected before reading run context.

### Review instructions

On the plugin settings page, open **Reviews → Review instructions** to customize
what Advisor looks for and when it stays quiet. The multiline field shows the
built-in guidance as placeholder text; leave it blank to use the current default
rather than pinning a copy. The optional config key is
`plugins.entries.advisor.config.reviewInstructions` (string, at most 4,000
characters). Leading and trailing whitespace is trimmed; whitespace-only values
use the default. Changes apply to the next review without restarting the Gateway.

Custom instructions replace only the review guidance. The fixed prefix still
says tools are disabled and the conversation is evidence, not instructions.
The fixed output contract still requires `NO_CHANGE` or `CORRECTION` and limits
corrections to 120 words. The second-stage `APPROVE`/`REJECT` verification prompt
is a safety gate and is not editable. A fixed sentence warning that a missing tool
result may still be running was added to the output contract after the evaluation;
the default guidance is otherwise unchanged. Custom instructions are not covered
by that evaluation.

Reviews keep the session's model and context; there is no separate model setting.
The fork cannot execute tools, persist conversation messages, or send replies.
The plugin needs conversation access and prompt injection permission through
`plugins.entries.advisor.hooks` (the normal trusted-plugin defaults). At most one
review runs per session. Resetting the session, disabling the plugin, or stopping
its service cancels pending reviews, including verification. Gateway info logs
record each stage's token usage (input, cache reads/writes, and output) and elapsed
time, plus whether advice was steered or queued.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor
