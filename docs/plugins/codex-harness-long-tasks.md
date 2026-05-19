---
sidebarTitle: "Codex long tasks"
---

# Codex Long-Task Reliability

Use this runbook when Codex-backed Telegram, cron, or task runs look like they
stall during long research, scraping, media, code, or report-generation work.

This page is based on a field report from a local macOS LaunchAgent deployment
running OpenClaw stable `2026.5.7` with:

- `messages.queue.mode: "collect"`
- `agents.defaults.maxConcurrent: 4`
- `cron.maxConcurrentRuns: 3`
- `plugins.entries.codex.config.appServer.requestTimeoutMs: 1200000`
- Codex app-server stdio transport with priority service tier

Even with that setup, multi-step jobs could still fail after Codex went quiet
while synthesizing the final answer. The key symptom was repeated gateway log
entries like:

```text
[agent/embedded] codex app-server turn idle timed out waiting for completion
[agent/embedded] embedded run failover decision: ... reason=timeout ... rawError=codex app-server attempt timed out
```

The important lesson is that the OpenClaw task queue, cron concurrency, and
Codex app-server quiet-window watchdog are separate systems. Raising
`appServer.requestTimeoutMs` does not by itself extend the post-turn quiet
window while OpenClaw waits for Codex to emit `turn/completed`.

## Quick Fix

Update OpenClaw first. The Codex harness now exposes
`appServer.turnCompletionIdleTimeoutMs` and disarms the short post-tool watchdog
when Codex emits non-terminal activity for the same turn. See
[Codex harness reference](/plugins/codex-harness-reference#timeouts).

Then set both app-server timeouts explicitly:

```bash
openclaw config patch --stdin <<'JSON'
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            requestTimeoutMs: 1200000,
            turnCompletionIdleTimeoutMs: 600000,
            serviceTier: "priority"
          }
        }
      }
    }
  }
}
JSON
openclaw config validate
openclaw gateway restart
```

Use a larger value only for deployments that intentionally run long unattended
Codex tasks. A too-large quiet window can delay recovery from a genuinely stuck
native Codex turn.

If `openclaw config validate` rejects `turnCompletionIdleTimeoutMs`, the
installed OpenClaw build is older than the Codex harness timeout fix. Remove the
field, update OpenClaw, restart the gateway, and validate again.

## Diagnose The Failure Mode

First check that the gateway and task ledger are healthy:

```bash
openclaw gateway status --json --require-rpc
openclaw tasks audit --json
openclaw cron status --json
```

Then inspect recent timeout symptoms:

```bash
rg -n \
  "codex app-server turn idle timed out|timeout-compaction|attempt timed out|lane wait exceeded" \
  ~/.openclaw/logs/gateway.err.log
```

Interpretation:

| Symptom                                      | Likely meaning                                                                 | What to do                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `turn idle timed out waiting for completion` | Codex did not emit terminal turn completion within the quiet window.           | Update OpenClaw and tune `appServer.turnCompletionIdleTimeoutMs`.                              |
| `timeout-compaction` near high prompt usage  | The direct/session context is too large and timeout recovery tried compaction. | Reset or compact the chat/session; move long work to isolated tasks.                           |
| `lane wait exceeded`                         | The runtime lane was waiting on another active run.                            | Check cron/task concurrency and active tasks.                                                  |
| `tasks audit` reports `lost`                 | The task record outlived its backing session state.                            | Inspect the task, preserve artifacts, and rerun as an isolated task with explicit checkpoints. |

## Queueing Is Not Durability

`messages.queue.mode: "collect"` prevents ordinary follow-up messages from
interrupting an active chat turn, but it does not make that chat turn durable.
For work that can take minutes or hours, route the work through isolated cron or
task execution and write artifacts incrementally.

Recommended operator prompt:

```text
#longtask detached, isolated cron.
Goal: ...
Inputs: ...
Artifacts: ...
Verification: ...
Checkpoint cadence: every 5-10 minutes.
Final delivery: short summary plus paths.
Commit/push: yes/no.
```

Recommended implementation pattern for custom launchers:

- Create a checkpoint directory before scheduling the job.
- Write `status.md` and `events.md` before the first model call.
- After each meaningful step, append changed paths, verification, and next
  step.
- Before a long synthesis step, save source notes or intermediate artifacts so a
  retry can resume instead of starting over.
- Send progress out-of-band every 5-10 minutes for human-visible long runs.
- For repo work, inspect `git status` before editing and stage only files owned
  by that job.

## Field Report Summary

In the field deployment that motivated this runbook, the operator tried:

- Raising `appServer.requestTimeoutMs` to 20 minutes.
- Keeping Telegram message queueing in `collect` mode.
- Increasing safe local parallelism to 4 agent runs and 3 cron runs.
- Moving explicit long work to isolated cron jobs.
- Adding local checkpoint files and Telegram progress conventions.
- Resetting high-context direct Telegram sessions.

Those changes improved queueing and recovery, but did not eliminate failures
because the remaining failure was the Codex app-server turn-completion quiet
window. The upstream fix is to use the newer harness behavior plus
`appServer.turnCompletionIdleTimeoutMs`, and to keep long jobs durable through
checkpointed artifacts.

## Maintainer Follow-Ups

Useful product improvements beyond this runbook:

- `openclaw doctor --deep` could count recent Codex app-server idle timeouts and
  suggest `turnCompletionIdleTimeoutMs` when the installed schema supports it.
- `openclaw tasks audit --json` could include a hint when `lost` tasks are tied
  to Codex app-server timeout runs.
- The cron/task CLI could expose a first-class checkpoint path in task metadata
  so operator scripts do not need to encode it only in prompts.

## See Also

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference#timeouts)
- [Background tasks](/automation/tasks)
- [Scheduled tasks](/automation/cron-jobs)
- [Command queue](/concepts/queue)
