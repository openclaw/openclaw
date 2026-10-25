---
doc-schema-version: 1
summary: "Migrate retired heartbeat monitors to ordinary automation jobs"
read_when:
  - Upgrading an installation with heartbeat configuration or HEARTBEAT.md
  - Finding the automation that replaced an agent's heartbeat monitor
  - Updating an integration that uses legacy heartbeat commands or events
title: "Heartbeat migration"
sidebarTitle: "Heartbeat migration"
---

<Note>
Heartbeat monitoring now uses ordinary [automation jobs](/automation/cron-jobs).
Doctor converts existing monitors into editable jobs with their own schedules,
policies, scratch, and run history.
</Note>

A scheduled check belongs to an automation job. Its schedule, prompt, scratch,
model, session, and delivery settings live with that job. Background-command,
task, hook, and restart follow-ups use normal session execution; they do not
require a periodic monitor or an enabled cron scheduler.

<a id="quick-start-beginner" />
<a id="config" />
<a id="scope-and-precedence" />

## Upgrade an existing monitor

Use the upgraded CLI to run Doctor:

```bash
openclaw doctor --fix
```

Then inspect all jobs, including disabled ones:

```bash
openclaw automations list --all
```

Doctor converts each existing monitor into an ordinary editable job. It keeps
its identity, run history, scratch bytes and revisions (including deletion
tombstones), disabled or auto-disabled state, scheduling anchor, and pending
scheduling slots. It also converts legacy
`heartbeat-task:*` jobs and imports supported `HEARTBEAT.md` content and task
blocks before retiring their old inputs.

Doctor removes legacy `agents.defaults.heartbeat` and
`agents.entries.*.heartbeat` settings and special channel heartbeat visibility
configuration only after their canonical jobs have been persisted and verified.
If conversion is blocked, the diagnostic names the
remaining input; resolve that problem and rerun Doctor rather than deleting the
configuration or scratch manually.

After migration, edit the ordinary job. Repeated
Doctor runs, config reloads, and Gateway restarts do not overwrite your job edits
or recreate a deleted monitor. A one-time provisioning receipt survives job
deletion, so deleting a default monitor is a lasting choice.

Imported `HEARTBEAT.md` bytes are archived under the state directory at
`backups/heartbeat-migration/` before the original file is removed. If the
workspace and state directory are on different filesystems, Doctor also keeps
the original in a private `HEARTBEAT.md.doctor-archived.*` directory beside its
former location. Writes through an already-open file descriptor remain
recoverable there. A file recreated after completed migration is retained and
reported; it does not overwrite the operator-owned job.

If existing scratch differs from `HEARTBEAT.md` and was not imported from that
file, Doctor preserves the scratch and original file, prints a notice, and
completes the conversion. Explicitly unset scratch stays unset. The automation
uses its existing scratch; review the retained file before copying any wanted
instructions into the job. Repeating Doctor keeps both originals and succeeds.

Doctor prints this one-time note when migration completes:

> Migrated heartbeats now use standard Automations delivery. Heartbeat-specific duplicate suppression and no-route skipping were removed: repeated updates can be delivered, and a missing route no longer skips the run before execution. Delivery failures follow ordinary automation handling. Review the migrated jobs' delivery settings if you relied on either behavior.

Migrated model overrides follow the agent's existing model policy. If a heartbeat
model is outside that policy, Doctor drops the job's model override and reports
the affected agent, job, dropped model, and configured default. The job then uses
normal automation model selection. Doctor does not expand the allowlist. To use
a different model, choose an allowed model for the job or add the desired model
to the agent's `modelPolicy.allow` before selecting it. Allowed overrides are
preserved.

<Warning>
The shared-state database advances to schema 30 so an older Gateway cannot run
these jobs while ignoring their new execution or delivery policies. Keep a
verified backup before upgrading. To roll back, restore the pre-upgrade backup
into a separate state directory; do not lower schema version markers. See
[Database schemas](/reference/database-schemas).
</Warning>

Heartbeat migration adds no per-agent schema change. The current agent schema is
31; its old `heartbeat_outcomes` table
is retained for migration. Meaningful pending results that still belong to the
current session move into ordinary session context without sending a notification.
Facts from before the current session or from an expired session are not promoted
into a new conversation.

Doctor supports the heartbeat configuration and task shapes shipped from July
2026 onward. Older shapes are outside this migration. If an input cannot be
converted faithfully, Doctor retains it and reports the problem instead of
silently discarding its scheduling or delivery settings.

A bare `tasks:` line followed by ordinary checklist bullets stays unchanged in
the monitor's scratch, including scratch imported by an earlier Doctor. It does
not create scheduled jobs or block retirement. Incomplete task declarations still
require repair; update admission and Doctor use the same task validation, and
Doctor leaves an incomplete `HEARTBEAT.md` in place before importing it.

<a id="defaults" />
<a id="what-the-heartbeat-prompt-is-for" />
<a id="per-agent-heartbeats" />
<a id="active-hours-example" />
<a id="247-setup" />
<a id="multi-account-example" />
<a id="field-notes" />
<a id="delivery-behavior" />
<a id="visibility-controls" />
<a id="what-each-flag-does" />
<a id="per-channel-vs-per-account-examples" />
<a id="common-patterns" />

## First setup

Explicit setup provisions one enabled **Proactive check** job for the ambient
owner agent. It runs every 30 minutes unless the provider supplies a different
initial cadence, uses the agent's main conversation, waits for idle execution,
and delivers to a resolved owner DM. The job skips an explicitly empty scratch
checklist; missing scratch still runs. Edit its schedule, prompt, model, or
delivery like any other automation.

Provisioning happens once. Gateway startup and config reload do not create the
job, and deleting it remains a lasting choice. Other agents need their own
explicitly created jobs.

## Configure scheduled checks

Each former heartbeat monitor remains associated with its agent, not every chat
session. You can change, disable, or remove it like any other automation:

```bash
openclaw automations show <job-id>
```

```bash
openclaw automations edit <job-id> --message "Check the monitor scratch. Report only changes that need attention; otherwise reply NO_REPLY."
```

```bash
openclaw automations disable <job-id>
```

```bash
openclaw automations remove <job-id>
```

A shared-context check uses a named session target. An isolated check starts with
a fresh run context. `current` is different: it runs detached with bounded
context from the conversation captured when the job was created. See
[Execution styles](/automation/cron-jobs/payloads#execution-styles).

Optional job policies preserve the useful monitoring behavior:

- `activeHours` restricts execution to a timezone-aware window.
- `idleOnly` gives foreground work priority through normal scheduler and session
  admission.
- `delivery.target: "owner"` resolves an explicitly identified owner DM. It does
  not follow a group conversation as `channel: "last"` can.
- `delivery.directPolicy` permits or blocks DM delivery.
- `payload.includeReasoning` controls whether an ordinary job includes available
  model reasoning in delivery.
- `payload.skipIfScratchEmpty` skips a check with explicitly empty scratch;
  missing scratch is different from an empty checklist.

These are per-job settings, not a replacement global heartbeat configuration.
See [Automations](/automation/cron-jobs) for the canonical job reference.

<a id="monitor-scratch-optional" />
<a id="schedule-recurring-checks-with-automations" />
<a id="can-the-agent-update-its-scratch" />

## Monitor scratch

Scratch is private context attached to any automation job, stored in the shared
state database. Keep it short and task-specific; a job's present scratch is
included in its bounded run context.

Do not put secrets in scratch: private storage does not keep it out of the model
prompt. See [Job scratch and quiet results](/automation/cron-jobs#job-scratch-and-quiet-results)
for empty-checklist behavior and revision conflicts.

```bash
openclaw automations scratch <job-id>
```

```bash
openclaw automations scratch <job-id> --set "Check for newly blocked work. Report only actionable changes."
```

```bash
openclaw automations scratch <job-id> --unset
```

Scratch writes are revision-guarded. Use `--expected-revision <n>` to pin a known
revision. During an automation run, the agent can read or update its own scratch
through the automations tool without gaining access to other jobs.

Scratch is not a scheduler. Put recurring work in separate automation jobs,
not a `tasks:` block. Doctor imports supported legacy blocks once; runtime does
not parse them as schedules or read `HEARTBEAT.md`.

<a id="response-contract" />
<a id="cost-awareness" />
<a id="context-overflow-after-heartbeat" />

## Quiet results and run history

Return `NO_REPLY` when a check has no visible update. During an automation run,
use the self-scoped `record_result` action to record a meaningful outcome without
sending a message. `no_change` suppresses automatic delivery; execution errors
remain failures. See [Job scratch and quiet results](/automation/cron-jobs/payloads#job-scratch-and-quiet-results).

Scheduled checks can finish silently in a saved internal session too. A completed
check that returns `NO_REPLY` does not need an extra final-answer model request.

<a id="manual-wake-on-demand" />
<a id="immediate-session-events" />

## Immediate follow-ups

A background process completing, a task becoming blocked, or a restart finishing
uses ordinary session execution. It does not require an enabled recurring monitor.
Session admission keeps the follow-up with its original conversation and current
authority. An exec completion waits behind the turn that started it, allowing
that turn to finish and acknowledge its automation reminders without being
superseded by its own command. For a manual event, request immediate processing
explicitly:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

The legacy `set-heartbeats` control enables or disables the corresponding
migrated/default jobs, never all automations. `last-heartbeat` keeps its
compatibility event response. An untargeted `next-heartbeat` request attaches to
an eligible scheduled automation for the session; without one, it reports the
problem instead of waiting for an unspecified future user message. Prefer
explicit automation schedules for delayed work.

Transport keepalives, presence checks, and other infrastructure health signals
are separate from agent monitoring and keep their existing configuration.

## Related

- [Automation](/automation) — choose scheduled jobs or event-driven work
- [Automations](/automation/cron-jobs) — job configuration, delivery, and history
- [Automations CLI](/cli/cron) — inspect and edit jobs and scratch
- [System CLI](/cli/system) — manual events and compatibility controls
- [Database schemas](/reference/database-schemas) — upgrade and rollback safety
