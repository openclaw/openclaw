---
doc-schema-version: 1
summary: "Automations: scheduled jobs, webhooks, and Gmail PubSub triggers for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring external triggers (webhooks, Gmail) into OpenClaw
  - Deciding between heartbeat and automations for scheduled work
title: "Automations"
sidebarTitle: "Automations"
---

Automations are OpenClaw's built-in scheduler. The scheduler persists jobs, wakes the agent at the right time, and can deliver output to a chat channel, a webhook, or nowhere.

Manage automations with the `openclaw automations` CLI; `openclaw cron` remains an alias for the same commands.

## Quick start

<Steps>
  <Step title="Add a one-shot reminder">
    ```bash
    openclaw automations create "2027-02-01T16:00:00Z" \
      --name "Reminder" \
      --session main \
      --system-event "Reminder: check the automations docs draft" \
      --wake now \
      --delete-after-run
    ```
  </Step>
  <Step title="Check your jobs">
    ```bash
    openclaw automations list
    openclaw automations get <job-id>
    openclaw automations show <job-id>
    ```
  </Step>
  <Step title="See run history">
    ```bash
    openclaw automations runs <job-id>
    ```
  </Step>
</Steps>

## Where each section moved

This page is an index. Each section below moved to a child page, and every anchor from the single-page version still resolves here.

### Runtime model and promotion

[How automations work](/automation/cron-jobs/how-it-works) — Runtime model, run lifecycle, and job promotion.

- <a id="how-automations-work"></a>[How automations work](/automation/cron-jobs/how-it-works#how-automations-work)
- <a id="isolated-run-hardening"></a>[Isolated run hardening](/automation/cron-jobs/how-it-works#isolated-run-hardening)
- <a id="task-reconciliation"></a>[Run reconciliation](/automation/cron-jobs/how-it-works#task-reconciliation)
- <a id="promoting-a-repeated-job-into-an-automation"></a>[Promoting a repeated job into an automation](/automation/cron-jobs/how-it-works#promoting-a-repeated-job-into-an-automation)

### Schedule and trigger sections

[Automation schedules](/automation/cron-jobs/schedules) — Schedule kinds, cron rules, pacing, and condition watchers.

- <a id="schedule-types"></a>[Schedule types](/automation/cron-jobs/schedules#schedule-types)
- <a id="heartbeat-task-migration"></a>[Heartbeat task migration](/automation/cron-jobs/schedules#heartbeat-task-migration)
- <a id="stream-sources"></a>[Stream sources](/automation/cron-jobs/schedules#stream-sources)
- <a id="dynamic-cadence-pacing"></a><a id="dynamic-cadence-(pacing)"></a>[Dynamic cadence (pacing)](/automation/cron-jobs/schedules#dynamic-cadence-pacing)
- <a id="%2Floop-chat-shortcut"></a><a id="/loop-chat-shortcut"></a>[`/loop` chat shortcut](/automation/cron-jobs/schedules#%2Floop-chat-shortcut)
- <a id="day-of-month-and-day-of-week-use-or-logic"></a>[Day-of-month and day-of-week use OR logic](/automation/cron-jobs/schedules#day-of-month-and-day-of-week-use-or-logic)
- <a id="event-triggers-condition-watchers"></a><a id="event-triggers-(condition-watchers)"></a>[Event triggers (condition watchers)](/automation/cron-jobs/schedules#event-triggers-condition-watchers)

### Payload and execution sections

[Automation payloads](/automation/cron-jobs/payloads) — Payload kinds, agent-turn flags, and session execution styles.

- <a id="payloads"></a>[Payloads](/automation/cron-jobs/payloads#payloads)
- <a id="agent-turn-options"></a>[Agent-turn options](/automation/cron-jobs/payloads#agent-turn-options)
- <a id="param-message"></a>[`--message`](/automation/cron-jobs/payloads#param-message)
- <a id="param-model"></a>[`--model`](/automation/cron-jobs/payloads#param-model)
- <a id="param-fallbacks"></a>[`--fallbacks`](/automation/cron-jobs/payloads#param-fallbacks)
- <a id="param-clear-fallbacks"></a>[`--clear-fallbacks`](/automation/cron-jobs/payloads#param-clear-fallbacks)
- <a id="param-clear-model"></a>[`--clear-model`](/automation/cron-jobs/payloads#param-clear-model)
- <a id="param-thinking"></a>[`--thinking`](/automation/cron-jobs/payloads#param-thinking)
- <a id="param-clear-thinking"></a>[`--clear-thinking`](/automation/cron-jobs/payloads#param-clear-thinking)
- <a id="param-light-context"></a>[`--light-context`](/automation/cron-jobs/payloads#param-light-context)
- <a id="param-tools"></a>[`--tools`](/automation/cron-jobs/payloads#param-tools)
- <a id="command-payloads"></a>[Command payloads](/automation/cron-jobs/payloads#command-payloads)
- <a id="script-payloads"></a>[Script payloads](/automation/cron-jobs/payloads#script-payloads)
- <a id="execution-styles"></a>[Execution styles](/automation/cron-jobs/payloads#execution-styles)
- <a id="codex-apps-in-scheduled-automations"></a>[Codex apps in scheduled automations](/automation/cron-jobs/payloads#codex-apps-in-scheduled-automations)
- <a id="main-session-vs-current-vs-isolated-vs-custom"></a>[Main session vs current vs isolated vs custom](/automation/cron-jobs/payloads#main-session-vs-current-vs-isolated-vs-custom)
- <a id="what-fresh-session-means-for-isolated-jobs"></a>[What 'fresh session' means for isolated jobs](/automation/cron-jobs/payloads#what-fresh-session-means-for-isolated-jobs)
- <a id="unattended-run-contract"></a>[Unattended run contract](/automation/cron-jobs/payloads#unattended-run-contract)
- <a id="subagent-and-discord-delivery"></a>[Subagent and Discord delivery](/automation/cron-jobs/payloads#subagent-and-discord-delivery)

### Delivery sections

[Automation delivery](/automation/cron-jobs/delivery) — Delivery modes, failure notifications, and output language.

- <a id="delivery-and-output"></a>[Delivery and output](/automation/cron-jobs/delivery#delivery-and-output)
- <a id="failure-notifications"></a>[Failure notifications](/automation/cron-jobs/delivery#failure-notifications)
- <a id="output-language"></a>[Output language](/automation/cron-jobs/delivery#output-language)

### Management and configuration sections

[Manage automations](/automation/cron-jobs/managing-jobs) — CLI examples, management commands, run history, and config keys.

- <a id="cli-examples"></a>[CLI examples](/automation/cron-jobs/managing-jobs#cli-examples)
- <a id="one-shot-reminder"></a>[One-shot reminder](/automation/cron-jobs/managing-jobs#one-shot-reminder)
- <a id="recurring-isolated-job"></a>[Recurring isolated job](/automation/cron-jobs/managing-jobs#recurring-isolated-job)
- <a id="model-and-thinking-override"></a>[Model and thinking override](/automation/cron-jobs/managing-jobs#model-and-thinking-override)
- <a id="webhook-output"></a>[Webhook output](/automation/cron-jobs/managing-jobs#webhook-output)
- <a id="command-output"></a>[Command output](/automation/cron-jobs/managing-jobs#command-output)
- <a id="managing-jobs"></a>[Managing jobs](/automation/cron-jobs/managing-jobs#managing-jobs)
- <a id="conversational-management"></a>[Conversational management](/automation/cron-jobs/managing-jobs#conversational-management)
- <a id="cli-management"></a>[CLI management](/automation/cron-jobs/managing-jobs#cli-management)
- <a id="configuration"></a>[Configuration](/automation/cron-jobs/managing-jobs#configuration)
- <a id="retry-behavior"></a>[Retry behavior](/automation/cron-jobs/managing-jobs#retry-behavior)
- <a id="maintenance"></a>[Maintenance](/automation/cron-jobs/managing-jobs#maintenance)
- <a id="legacy-store-migration"></a>[Legacy store migration](/automation/cron-jobs/managing-jobs#legacy-store-migration)

### Inbound webhook sections

[Inbound webhooks](/automation/cron-jobs/webhooks) — Gateway HTTP hooks for external callers.

- <a id="webhooks"></a>[Webhooks](/automation/cron-jobs/webhooks#webhooks)
- <a id="enable-and-test-an-agent-hook"></a>[Enable and test an agent hook](/automation/cron-jobs/webhooks#enable-and-test-an-agent-hook)
- <a id="authentication"></a>[Authentication](/automation/cron-jobs/webhooks#authentication)
- <a id="post-hooks-wake"></a>[POST /hooks/wake](/automation/cron-jobs/webhooks#post-hooks-wake)
- <a id="post-hooks-agent"></a>[POST /hooks/agent](/automation/cron-jobs/webhooks#post-hooks-agent)
- <a id="mapped"></a>[Mapped hooks (`POST /hooks/<name>`)](/automation/cron-jobs/webhooks#mapped-hooks-post-hooks-name)
- <a id="verify-and-troubleshoot-hook-requests"></a>[Verify and troubleshoot hook requests](/automation/cron-jobs/webhooks#verify-and-troubleshoot-hook-requests)

### Gmail sections

[Gmail PubSub triggers](/automation/cron-jobs/gmail) — Gmail inbox triggers through Google Pub/Sub.

- <a id="gmail-pubsub-integration"></a>[Gmail PubSub integration](/automation/cron-jobs/gmail#gmail-pubsub-integration)
- <a id="configure-a-restricted-gmail-reader-recommended"></a><a id="configure-a-restricted-gmail-reader-(recommended)"></a>[Configure a restricted Gmail reader (recommended)](/automation/cron-jobs/gmail#configure-a-restricted-gmail-reader-recommended)
- <a id="authenticate-the-reader-model"></a>[Authenticate the reader model](/automation/cron-jobs/gmail#authenticate-the-reader-model)
- <a id="connect-gmail-transport"></a>[Connect Gmail transport](/automation/cron-jobs/gmail#connect-gmail-transport)
- <a id="verify-the-reader-boundary"></a>[Verify the reader boundary](/automation/cron-jobs/gmail#verify-the-reader-boundary)
- <a id="gateway-auto-start"></a>[Gateway auto-start](/automation/cron-jobs/gmail#gateway-auto-start)
- <a id="manual-one-time-setup"></a>[Manual one-time setup](/automation/cron-jobs/gmail#manual-one-time-setup)
- <a id="select-the-gcp-project"></a>[Select the GCP project](/automation/cron-jobs/gmail#select-the-gcp-project)
- <a id="create-topic-and-grant-gmail-push-access"></a>[Create topic and grant Gmail push access](/automation/cron-jobs/gmail#create-topic-and-grant-gmail-push-access)
- <a id="start-the-watch"></a>[Start the watch](/automation/cron-jobs/gmail#start-the-watch)
- <a id="gmail-model-override"></a>[Gmail model override](/automation/cron-jobs/gmail#gmail-model-override)

### Troubleshooting sections

[Automation troubleshooting](/automation/cron-jobs/troubleshooting) — Command ladder and common automation failure shapes.

- <a id="troubleshooting"></a>[Troubleshooting](/automation/cron-jobs/troubleshooting#troubleshooting)
- <a id="command-ladder"></a>[Command ladder](/automation/cron-jobs/troubleshooting#command-ladder)
- <a id="automations-not-firing"></a>[Automations not firing](/automation/cron-jobs/troubleshooting#automations-not-firing)
- <a id="job-fired-but-no-delivery"></a>[Job fired but no delivery](/automation/cron-jobs/troubleshooting#job-fired-but-no-delivery)
- <a id="automations-or-heartbeat-appear-to-prevent-new-style-rollover"></a>[Automations or heartbeat appear to prevent /new-style rollover](/automation/cron-jobs/troubleshooting#automations-or-heartbeat-appear-to-prevent-new-style-rollover)
- <a id="timezone-gotchas"></a>[Timezone gotchas](/automation/cron-jobs/troubleshooting#timezone-gotchas)>>>>>>> ae8ca5d5b15 (feat(cron): shell precheck gate to skip LLM when no work)

## Related

- [Automation](/automation) — all automation mechanisms at a glance
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [Standing intents](/concepts/standing-intents) — event-triggered work instead of a schedule
- [Standing orders](/automation/standing-orders) — the operating authority a scheduled run acts under
- [Timezone](/concepts/timezone) — timezone configuration

## Job precheck gate (zero-token skip)

Optional **shell precheck** on any job ([#112371](https://github.com/openclaw/openclaw/issues/112371)) runs **before** the payload (including before an `agentTurn` model session). When the gate reports no work, the run is recorded as `skipped` with reason `precheck-no-work` and **no model call** is started. Skipped precheck runs use the consecutive-skip counter (not execution-error backoff).

```json
{
  "precheck": {
    "kind": "exec",
    "command": "bash ~/.openclaw/scripts/inbox-has-mail.sh",
    "timeoutMs": 30000
  },
  "payload": { "kind": "agentTurn", "message": "Triage unread mail…" }
}
```

**Default exit-code contract**

| Exit  | Meaning                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `0`   | Work exists → run payload                                                                                               |
| `2`   | No work → `skipped` / `precheck-no-work`                                                                                |
| other | Precheck error (`status=error`); with `onError: "skip"` → `skipped` / `precheck-skipped-error` (not `precheck-no-work`) |

Stdout prefixes `WORK_NEEDED` / `NO_WORK` at the start of stdout override the exit code when present.

```bash
openclaw cron add --name inbox-poll --cron "*/15 * * * *" \
  --session isolated \
  --precheck-command 'bash ~/.openclaw/scripts/inbox-has-mail.sh' \
  --message 'Triage unread inbox…'
```

**Security (durable contract):** the precheck command is a **persisted Gateway-host shell admission step**. It runs unattended with a bounded timeout (default 30s, capped at 5m) in the Gateway environment:

- **POSIX:** fixed trusted `/bin/sh -c` (inherited `$SHELL` is ignored)
- **Windows:** fixed trusted `cmd.exe` via `resolveTrustedWindowsCmdExe` with `/d /s /c` (inherited `%ComSpec%` is ignored). Unattended precheck always reports real `cmd.exe` wrapper transport facts to the shared exec policy. Under default `security=allowlist`, that **fails closed** (requires approval / is denied for unattended runs)—same posture as other unattended `cmd.exe /c` host shells. Use `security=full` only with explicit operator intent if Windows precheck must run without approval; do not expect allowlist mode to admit unattended precheck on Windows.

Host-shell authorization reuses the **same surface as exec / system-run**:

1. `cron.triggers.enabled` must be **true** (unattended host-shell switch), and
2. exec security `deny|allowlist|full` (approvals file + shell allowlist analysis on the inner command), and
3. the job payload must allow core **`exec`** via `payload.toolsAllow` (include `"exec"`, a matching group, or `"*"`). Absent/`toolsAllow` that omits `exec` fails closed at precheck authz with `precheck-policy-denied` — no shell spawn. Capless legacy agent jobs that **gain** a precheck via `cron.update` / CLI edit take the Gateway tool-runtime patch path (explicit-cap rules + caller-bound scheduled authority); create/edit helpers stamp default `toolsAllow: ["*"]` only when still undefined and do not widen an explicit narrower cap.

Denied prechecks record `status=error` with reason `precheck-policy-denied` and **do not** start a payload/model turn. Treat commands like any other unattended shell you schedule — only trusted scripts, secrets in files/env (not inline), known directory preferred over ad-hoc one-liners.

**Proposed product shape (contributor design; owner accept/reject still required):**

This PR proposes `job.precheck` as a **second** persisted cron admission surface next to condition `trigger` (dual-contract). Maintainers may accept, reject, or reshape before merge — author comments are not owner approval.

|                    | `precheck`                                                  | condition `trigger`                     |
| ------------------ | ----------------------------------------------------------- | --------------------------------------- |
| Executor           | fixed trusted host shell (`/bin/sh -c` / trusted `cmd.exe`) | code-mode / tool executor               |
| Purpose            | cheapest run-vs-skip before _any_ payload                   | watchers with JS state / tools / `fire` |
| Outcome vocabulary | `precheck-no-work` skip, `precheck-policy-denied` error     | `fire` / not-met                        |
| Ordering           | always first when set                                       | after precheck when both set            |
| Authz              | `cron.triggers.enabled` + exec deny/allowlist/full          | `cron.triggers.enabled` + code-mode     |

**Why not unify into triggers only:** forcing host-shell pollers through code-mode burns a heavier executor and a different failure model for “exit 2 means quiet.” **Why not drop triggers:** stateful JSON/`fire`/tool watchers cannot be expressed as a single shell exit code without reinventing code-mode inside `precheck`.

**Operator contract (if accepted):** both fields may appear on one job; precheck always runs first. Host-shell precheck would be a durable unattended Gateway execution boundary under the existing exec-policy stack (not a bypass).

Example precheck scripts (any language; exit `0`=work, `2`=skip, or print `WORK_NEEDED`/`NO_WORK`):

```bash
#!/usr/bin/env bash
# ~/.openclaw/scripts/gh-open-issues.sh — wake only when the repo has open issues
count=$(gh issue list --repo owner/repo --state open --json number -q 'length' 2>/dev/null || echo 0)
if [ "$count" -gt 0 ]; then echo "WORK_NEEDED: $count open"; else echo "NO_WORK"; fi
```

```bash
#!/usr/bin/env bash
# ~/.openclaw/scripts/calendar-events-today.sh — wake only on days with events
events=$(gog calendar list --today --json | jq 'length' 2>/dev/null || echo 0)
[ "$events" -gt 0 ] && exit 0 || exit 2
```

Use this for poller-style jobs that are usually quiet. Prefer **condition triggers** (`--trigger-script`) when you need JSON state, tool calls, or richer watchers — those use the code-mode executor and require `cron.triggers.enabled`. Prefer **command** / **script** payloads when the whole job is non-LLM automation rather than “maybe then think.”

### Choosing a gate: precheck vs trigger vs command/script

OpenClaw has four ways to avoid or replace an LLM turn. Pick by what the job needs:

| Need                                                                  | Use                                       |       Runs LLM?       | Requires `cron.triggers.enabled`? |
| --------------------------------------------------------------------- | ----------------------------------------- | :-------------------: | :-------------------------------: |
| "Only wake the model when a cheap shell check says there's work"      | **`precheck`** (this feature)             | Only when gate passes |  Yes (host-shell shared switch)   |
| "Watch a condition with JS + persisted state, fire payload on change" | **`trigger` script** (`--trigger-script`) |  Only on `fire:true`  |                Yes                |
| "The whole job is a shell command; deliver its stdout"                | **`command` payload**                     |         Never         |                No                 |
| "The whole job is a JS script in the code-mode executor"              | **`script` payload**                      | Never (runs headless) |                Yes                |

Rules of thumb:

- **Poller that is usually quiet, real work needs the agent** → `precheck` + `agentTurn`. Cheapest host-shell gate (shared `cron.triggers.enabled` + exec policy); no code-mode/tool executor cost when skipped.
- **Need JSON state / dedupe across runs / tool calls in the gate** → condition `trigger` (it exposes `trigger.state` and the tool API).
- **No model ever, just run a thing and maybe post output** → `command` (argv/shell) or `script` (JS) payload.
- `precheck` and a `trigger` can coexist: the precheck runs first (skip early, zero code-mode cost), then the trigger evaluates. A firing `trigger` message is still appended to the payload as before.

Recipe — gate an isolated agent poller on a `gh` check with zero tokens when clean:

```bash
openclaw cron add --name pr-triage --cron "*/30 * * * *" \
  --session isolated \
  --precheck-command 'test "$(gh pr list --repo owner/repo --state open --json number -q "length")" -gt 0 && echo WORK_NEEDED || echo NO_WORK' \
  --message "Review open PRs and post a summary."
```

### Cost stats: measure the savings

`openclaw cron stats` rolls up run history into skipped-vs-ran and token totals so you can see the gate paying off:

```bash
openclaw cron stats                 # fleet-wide, last 200 runs/job
openclaw cron stats --id <jobId>    # one job
openclaw cron stats --json          # machine-readable
```

Output highlights `skipped` (with skip-rate %), `precheckSkipped` (runs the shell gate short-circuited), `modelRuns`, and `tokens`. A healthy poller after adding `precheck` shows a high skip-rate and low `modelRuns`.

### Recipe: convert a poller `agentTurn` into `precheck` + `agentTurn`

Before — always pays for a model turn:

```bash
openclaw cron add --name pr-triage --cron "*/30 * * * *" \
  --session isolated --message "Review open PRs and summarize."
```

After — model only runs when there are open PRs:

```bash
openclaw cron edit pr-triage \
  --precheck-command 'test "$(gh pr list --repo owner/repo --state open --json number -q "length")" -gt 0 && echo WORK_NEEDED || echo NO_WORK'
# verify with: openclaw cron stats --id pr-triage
```
