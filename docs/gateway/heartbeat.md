---
summary: "Migrate retired heartbeat monitors to ordinary automation jobs"
read_when:
  - Upgrading an installation with heartbeat configuration or HEARTBEAT.md
  - Finding the automation that replaced an agent's heartbeat monitor
  - Updating an integration that uses legacy heartbeat commands or events
title: "Heartbeat migration"
sidebarTitle: "Heartbeat migration"
---

<Note>
Heartbeat monitoring is now ordinary [automation](/automation/cron-jobs). There
is no separate heartbeat scheduler or execution engine. Existing monitors are
migrated rather than discarded.
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

Migrated jobs use standard Automations delivery. Heartbeat-specific duplicate
suppression and no-route skipping are removed: repeated updates can be delivered,
and a missing route no longer skips a run before execution. Delivery failures
follow [ordinary automation handling](/automation/cron-jobs/delivery). Doctor
prints a one-time note when the migration completes. Review the job's delivery
settings if you relied on either former behavior.

<Warning>
The shared-state database advances to schema 21 so an older Gateway cannot run
these jobs while ignoring their new execution or delivery policies. Keep a
verified backup before upgrading. To roll back, restore the pre-upgrade backup
into a separate state directory; do not lower schema version markers. See
[Database schemas](/reference/database-schemas).
</Warning>

The per-agent database stays at schema 24. Its old `heartbeat_outcomes` table
remains inert until a later approved schema change; meaningful pending context
moves to ordinary session delivery/context ownership.

Doctor supports the heartbeat configuration and task shapes shipped from July
2026 onward. Older shapes are outside this migration. If an input cannot be
converted faithfully, Doctor retains it and reports the problem instead of
silently discarding its scheduling or delivery settings.

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
- `payload.includeReasoning` preserves an explicit choice to include available
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

Return `NO_REPLY` when a check has no visible update. Ordinary automation run
history distinguishes successful silence, delivery failure, execution failure,
and intentional skips. Meaningful internal results can be recorded through the
current run's `record_result` action; it does not send a message by itself.

The retired `heartbeat_respond` tool is no longer needed. Use the normal final
reply for an alert, `NO_REPLY` for silence, self-scoped scratch actions for
checklist updates, and `next_check` when the job has pacing enabled.

<a id="manual-wake-on-demand" />

## Immediate follow-ups

A background process completing, a task becoming blocked, or a restart finishing
is an event, not a recurring check. Its owner submits a follow-up to the target
session. Normal session admission prevents it from interrupting unrelated active
work or arriving in a reset or replaced session.

Follow-ups for an internal conversation, such as Control UI or WebChat, remain
in that conversation. A failed transcript publication does not redirect them
to an automation's external delivery target or acknowledge them as delivered.

For a manual event, request immediate session processing explicitly:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

## Legacy integration compatibility

The `openclaw system heartbeat` CLI commands have been removed. Use
`openclaw automations show|enable|disable <job-id>` to inspect or control the
converted jobs.

Gateway protocol v4 remains supported. Existing `last-heartbeat`,
`set-heartbeats`, `heartbeat` events, and `next-heartbeat` wake-mode values remain
deprecated boundary interfaces backed by canonical automation and session state.
They do not imply another heartbeat engine.

Legacy heartbeat enable/disable controls apply only to the corresponding
migrated or default monitor jobs, never all automations. Untargeted deferred
`next-heartbeat` requests require a valid scheduled target; an unavailable target
produces an actionable result rather than silently waiting for an unspecified
future user message. The historical `system event --session-key` exception stays
immediate even with `--mode next-heartbeat`; prefer `--mode now` to state that
intent explicitly. Use explicit automation scheduling for delayed work.

Removal of these wire names is deferred to an owner-approved protocol v5 change
with client follow-through. Heartbeat plugin SDK execution aliases and reply
helpers have been removed as an approved breaking change. Update affected plugins
before upgrading the host; see the [SDK migration](/plugins/sdk-migration/removed-surfaces#heartbeat-execution-and-reply-helpers).
Bundled callers use canonical APIs.
See the [heartbeat retirement design](https://github.com/openclaw/openclaw/issues/134994).

Transport keepalives, presence checks, and other infrastructure health signals
are unrelated to the retired agent monitor and remain in place.

## Related

- [Automation](/automation) — choose scheduled jobs or event-driven work
- [Automations](/automation/cron-jobs) — job configuration, delivery, and history
- [Automations CLI](/cli/cron) — inspect and edit jobs and scratch
- [System CLI](/cli/system) — manual events and legacy compatibility
- [Database schemas](/reference/database-schemas) — upgrade and rollback safety
