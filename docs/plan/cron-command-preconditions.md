# Cron Command Preconditions

## Draft PR Title

feat(cron): add command preconditions for conditional agent runs

## Summary

OpenClaw cron is good at precise scheduling and agent-driven background work, but
it does not currently have a native deterministic guard step. If a user wants to
run a cheap scripted check every few minutes and only call the model when that
check finds something actionable, the practical answer today is to use system
cron outside OpenClaw.

This proposal adds an optional cron command precondition. The Gateway runs a
configured argv-based command before the existing cron payload. If the command
says "nothing to do", the cron run is recorded as skipped and no heartbeat or
agent/model turn is started. If the command says "action needed", OpenClaw
continues with the existing `systemEvent` or `agentTurn` flow.

## Four PR Questions

- **Problem:** OpenClaw cron can schedule agent work, but it cannot natively run
  a cheap deterministic check before deciding whether an LLM-backed cron payload
  is needed.
- **Why it matters:** Many cron/heartbeat-style jobs are mostly no-ops. Users
  pay latency and LLM API tokens on every agent turn even when a script could
  determine that nothing needs attention. This pushes cost-conscious users
  toward system cron, splitting scheduling, audit history, failure alerts, and
  OpenClaw delivery across two systems.
- **What changed:** Add an optional argv-based command precondition to cron jobs.
  Exit `0` skips without enqueueing heartbeat or starting the agent runner; exit
  `2` continues to the existing `systemEvent` or `agentTurn` payload; other
  failures are recorded as cron errors.
- **What did NOT change:** Existing cron jobs without a precondition behave
  exactly as before. This does not add shell-string execution, replace
  hooks/plugins, or turn cron into a general workflow engine.

## Problem

OpenClaw currently has two cron payload styles:

- `systemEvent`: enqueue text into a session and request heartbeat
- `agentTurn`: run an isolated/current/custom agent turn

That means cron can schedule agent work, but it cannot natively express:

1. Run a deterministic script first.
2. Inspect its exit code.
3. Only invoke the LLM when the script finds a condition that needs LLM-style
   work.

This matters for monitoring-style jobs:

- check whether any authored PR has conflicts, failed checks, or review feedback
- check whether a service health probe changed state
- check whether an inbox/query count crossed a threshold
- check whether a file/report differs from the last recorded state

Those checks are usually deterministic and cheap. Calling the model every time
wastes tokens and can create noisy no-op agent turns. Users can work around this
with system cron, but then scheduling, run history, task tracking, failure
alerts, and OpenClaw delivery are split across two systems.

## Cost And Token Impact

The main user-facing benefit is avoiding LLM spend for scheduled no-op
automation.

Today, a user who wants "check every 15 minutes, act only when needed" has two
unsatisfying options:

1. Schedule the work as an OpenClaw heartbeat/cron agent turn. This keeps the
   work inside OpenClaw, but the no-op path can still require a model call just
   to conclude nothing needs action.
2. Use system cron. This keeps the no-op path cheap, but OpenClaw only sees the
   exceptional path and loses native ownership of scheduling, run history, task
   records, and failure/delivery policy.

Command preconditions give users the cheaper system-cron execution shape while
preserving OpenClaw as the scheduler:

- no-op check: script only, no model tokens
- actionable check: script output becomes context for the existing cron payload
- failed check: cron records an error and can use existing failure alerting

This is especially useful for high-frequency monitoring jobs where most runs are
expected to be no-ops. The feature turns those no-op runs from "agent/model turn
that says nothing changed" into "deterministic skip with diagnostics."

## Proposed Behavior

Add an optional `condition` field to cron jobs:

```ts
type CronCondition = {
  kind: "command";
  argv: string[];
  cwd?: string;
  timeoutSeconds?: number;
  triggerExitCode?: number;
  appendOutput?: boolean;
  maxOutputBytes?: number;
};
```

Execution semantics:

- If no `condition` is present, cron behaves exactly as it does today.
- If `condition.kind === "command"`, cron runs the command before the existing
  payload.
- Exit `0` means condition not met:
  - record the run as `skipped`
  - do not enqueue system events
  - do not request heartbeat
  - do not start an agent/model run
- Exit `triggerExitCode` means condition met:
  - continue with the existing cron payload
  - optionally append capped stdout/stderr to the `systemEvent.text` or
    `agentTurn.message`
- Any other nonzero exit means condition failed:
  - record the run as `error`
  - include capped stderr/stdout diagnostics
  - apply existing cron failure alert behavior
- Timeout means condition failed with `error`.

Default values:

```ts
triggerExitCode: 2;
timeoutSeconds: 30;
appendOutput: false;
maxOutputBytes: 8192;
```

## CLI Shape

Add flags to `openclaw cron add` and `openclaw cron edit`:

```bash
--check-command <path>
--check-arg <arg>
--check-cwd <path>
--check-timeout-seconds <n>
--check-trigger-exit-code <n>
--check-append-output
--check-max-output-bytes <n>
--clear-check
```

The CLI builds:

```json
{
  "condition": {
    "kind": "command",
    "argv": ["/home/captain/bin/check-prs", "--json"],
    "triggerExitCode": 2,
    "appendOutput": true
  }
}
```

## Example: Deterministic PR Monitor

Precheck script:

```bash
#!/usr/bin/env bash
set -euo pipefail

report="$(/home/captain/bin/find-pr-blockers --json)"
if jq -e '.blocked == 0' >/dev/null <<<"$report"; then
  exit 0
fi

printf '%s\n' "$report"
exit 2
```

Cron:

```bash
openclaw cron add \
  --name "Maintain my PRs" \
  --every 1h \
  --session isolated \
  --check-command /home/captain/bin/check-pr-blockers \
  --check-trigger-exit-code 2 \
  --check-append-output \
  --message "The precheck found PR blockers. Read the attached JSON, inspect the relevant PRs, and make the minimal changes needed to restore mergeability." \
  --tools exec,read,write
```

Most runs exit `0` and do not call the model. Only actionable runs become agent
work.

## Security Model

This feature must not introduce a persistent arbitrary shell execution surface.

Proposed v1 constraints:

- argv array only, no shell string
- no implicit shell
- command path must be explicit
- short timeout by default
- capped stdout/stderr
- optional cwd, normalized and validated
- no arbitrary environment variables in v1
- no stdin in v1

Recommended additional guard:

```json5
{
  cron: {
    commandConditions: {
      enabled: true,
      allowedPaths: ["/home/captain/.openclaw/workspace/scripts", "/usr/local/bin/openclaw-checks"],
    },
  },
}
```

If maintainers prefer a stricter first version, the PR can require
`cron.commandConditions.enabled: true` before accepting any command condition.
That keeps the default cron surface unchanged.

## Implementation Plan

### Types And Schema

Files:

- `src/cron/types.ts`
- `src/gateway/protocol/schema/cron.ts`
- `src/cron/normalize.ts`

Changes:

- Add `CronCondition`.
- Add optional `condition?: CronCondition` to `CronJob` / create / patch types.
- Validate `argv` is non-empty and each arg is a string.
- Validate numeric bounds for timeout, trigger exit code, and max output bytes.
- Preserve older cron files where `condition` is absent.

### Validation

Files:

- `src/cron/service/jobs.ts`
- config types under `src/config`

Changes:

- Add `assertConditionSupport`.
- Reject command conditions unless enabled if maintainers want an explicit
  opt-in.
- Reject relative or unsafe command paths unless the config explicitly allows
  them.
- Reject shell-shaped single strings.

### Execution

Files:

- `src/cron/service/timer.ts`
- possibly new `src/cron/service/condition.ts`

Changes:

- Before `executeMainSessionCronJob` or `executeDetachedCronJob`, run the
  condition.
- Use the existing argv-based process execution helper rather than shell
  execution.
- If exit `0`, return `status: "skipped"` with a condition diagnostic.
- If exit `triggerExitCode`, continue with existing behavior.
- If output append is enabled, cap and append output to the payload text for
  this run only. Do not mutate the stored job payload.
- If timeout or unexpected nonzero exit, return `status: "error"` with
  diagnostics.

### Diagnostics And Run History

Files:

- `src/cron/run-diagnostics.ts`
- `src/cron/run-log.ts`
- CLI display helpers under `src/cli/cron-cli`

Changes:

- Add diagnostic source `"condition"` or reuse `"cron-preflight"` with
  structured fields.
- Include command exit code, timeout state, and capped stdout/stderr.
- Show skipped precondition runs clearly in `openclaw cron runs`.

Example run history:

```text
skipped: condition command exited 0 (no action needed)
error: condition command exited 1
ok: condition command exited 2; agentTurn completed
```

### CLI

Files:

- `src/cli/cron-cli/register.cron-add.ts`
- `src/cli/cron-cli/register.cron-edit.ts`
- `src/cli/cron-cli/shared.ts`

Changes:

- Add check flags listed above.
- Print condition summary in `cron list` / `cron show`.
- Support `--clear-check` on edit.

### Docs

Files:

- `docs/automation/cron-jobs.md`
- `docs/cli/cron.md`
- possibly `docs/automation/index.md`

Docs should explain:

- OpenClaw cron remains an agent scheduler by default.
- Command preconditions are for cheap deterministic gates.
- Exit code contract.
- Security and allowlist requirements.
- Difference from `--tools exec`: the precondition runs before any model call;
  `--tools exec` lets the model choose to run a tool after the model call has
  already started.

## Test Plan

Unit tests:

- condition exit `0` skips without calling `runIsolatedAgentJob`
- condition exit `0` for main-session `systemEvent` does not call
  `enqueueSystemEvent` or `requestHeartbeat`
- condition exit `2` proceeds to existing `agentTurn`
- condition exit `2` proceeds to existing `systemEvent`
- unexpected nonzero exit records `error`
- timeout records `error`
- `appendOutput` appends capped stdout/stderr to run-local payload only
- stored job payload is not mutated by output append
- schema rejects empty argv
- schema rejects invalid timeout / max output / exit code
- CLI `cron add` builds expected `condition`
- CLI `cron edit --clear-check` removes condition

Regression tests:

- jobs without `condition` behave exactly as before
- existing `systemEvent` main jobs remain valid
- existing isolated `agentTurn` jobs remain valid
- run log filtering by `skipped` includes condition skips

## Real Behavior Proof Plan

Because this is a proposal PR rather than an implementation PR, there is no
after-fix runtime behavior to prove yet. The eventual implementation PR should
include real proof for:

- a condition exit `0` run that records `skipped` without a model call
- a condition exit `2` run that proceeds into `agentTurn`
- a main-session `systemEvent` condition skip that does not enqueue heartbeat
- a failed/timeout condition recorded in cron run history

## Non-goals

- No shell command strings in v1.
- No arbitrary env injection in v1.
- No stdin in v1.
- No full workflow engine.
- No model-side decision before the precheck. The point is to avoid the model
  call when deterministic logic says there is nothing to do.
- No replacement for hooks or plugin hooks.

## Maintainer Questions

1. Should command preconditions require an explicit config opt-in?
2. Should allowed paths be required in v1?
3. Is exit `2` an acceptable default for "condition met", or should it be
   configurable only with no default?
4. Should skipped condition runs create task records, or should task creation
   happen only after the condition triggers?
5. Should `appendOutput` support structured JSON handoff later, or is capped
   text enough for v1?

## Why This Belongs In OpenClaw

This keeps the common "cheap deterministic monitor, expensive agent only on
action" workflow inside OpenClaw's scheduler, run history, task tracking, and
delivery system.

Without this primitive, users who care about token spend naturally move those
jobs to system cron. That works, but it splits the operational model: system
cron owns the condition and OpenClaw only sees the exceptional path. A native
precondition lets OpenClaw remain the scheduler while still avoiding no-op model
calls.
