---
doc-schema-version: 1
summary: "Command ladder and fixes for jobs that do not fire or do not deliver"
read_when:
  - An automation did not fire at its scheduled time
  - A job ran but nothing arrived in chat
  - Diagnosing timezone or session rollover surprises
title: "Automation troubleshooting"
sidebarTitle: "Troubleshooting"
---

A command ladder and the common failure shapes for scheduled jobs. Part of the [Automations](/automation/cron-jobs) guide.

## Troubleshooting

### Command ladder

```bash
openclaw status
openclaw gateway status
openclaw automations status
openclaw automations list
openclaw automations runs <jobId> --limit 20
openclaw automations show <jobId>
openclaw logs --follow
openclaw doctor
```

<AccordionGroup>
  <Accordion title="Reminder creation rejected">
    - Empty delivery targets are rejected before normalization. Supply a valid target, or omit the unused optional object (for example, `delivery.failureDestination`) instead of filling its fields with empty strings.
    - A one-time `schedule.kind: "at"` cannot have a `trigger`. Remove `trigger` for an ordinary reminder. If the condition is intentional, use a recurring `every` or `cron` schedule instead. Rejected requests do not create a job; correct the named field before retrying.

  </Accordion>
  <Accordion title="Automations not firing">
    - `Default cron partition selection is unresolved` means older state was moved before its default partition was recorded. The Gateway continues running, but cron waits for an explicit choice. Run `openclaw doctor --fix` interactively, review the partition inventory, choose **Select the default cron partition**, then restart the Gateway. `--yes` and noninteractive runs leave the choice unresolved. Upgraded state retains its recorded partition when moved or restored to another directory.
    - Check the `cron.enabled` config setting and `OPENCLAW_SKIP_CRON` in the Gateway's launch environment. Either can disable automatic runs; clear both disable settings and restart the Gateway to enable scheduling.
    - Confirm the Gateway is running continuously.
    - `cron: queue drain delayed` after Gateway resume means a queued run could not be activated, for example because a storage write failed. The Gateway stays running and the request remains queued; inspect the accompanying error and repair the storage problem. A manual run still reports its storage error to the caller.
    - Use `openclaw automations list --all` to find disabled jobs and `openclaw doctor` to inspect recorded auto-disable reasons, including terminal one-shot execution failures. Fix the cause before running `openclaw automations enable <jobId>`. Operator cancellations and restart interruptions remain visible in run history, but do not increase consecutive failures, trigger failure alerts or automatic repair, or record an auto-disable. A job failure completed before webhook delivery was interrupted still counts. Enabled, unchanged time-scheduled agent-turn jobs interrupted before delivery retry once through cron, including one-shots. Other interrupted one-shots stay disabled to avoid replaying uncertain work; inspect their history before continuing manually.
    - A job disabled without an auto-disable reason may have paused because the conversation that created it was removed or archived, or lost its worktree. Its run history shows the skip reason and names the conversation. Restore the conversation, or accept running without it, before running `openclaw automations enable <jobId>`.
    - For `cron` schedules, verify timezone (`--tz`) vs the host timezone.
    - `reason: not-due` in run output means the manual run was checked with `openclaw automations run <jobId> --due` and the job was not due yet.
    - If the job's execution agent cannot be resolved, automatic and manual attempts record a failed task and a skipped run-history entry with the reason. Select an agent with `openclaw automations edit <jobId> --agent <id>`.
    - `Automation has no recorded inference account` means an older job has not adopted a stored account yet. An authorized operator can record the intended account with `openclaw automations edit <jobId> --model <provider/model>@<profileId>`; this also sets the primary model. For eligible host-managed accounts, `openclaw doctor --fix` backs up cron state and records the account the job's run would use (an explicit selection, or the first account in the normal account order) without pinning inherited models or changing fallbacks. When several accounts are eligible, Doctor names the others; if the account is unavailable or personal, Doctor names the job and the required action. Doctor also handles explicitly selected Codex runtimes that use host-managed accounts, recording the runtime with the account. Main-session targets, CLI runtimes, model-locked sessions, and other explicitly selected plugin runtimes are left unchanged; use the explicit edit command for a compatible stored account. A job on an environment or provider-config key keeps that key and needs no adoption; it stops instead of switching once a stored account becomes eligible. The refusal ends the run without trying fallback models. CLI-native login and configured credentialless inference do not require adopting a host profile; an unbound CLI job cannot select or automatically borrow one. Doctor does not infer historical account ownership from the last model in run history.
    - `Automation candidate is incompatible with its recorded inference account and route` means the selected model uses a different provider, or its runtime uses a CLI login that cannot replace the job's stored account. Model/default changes preserve account ownership. Select a model and host-managed runtime compatible with that account, or deliberately adopt another stored account with `openclaw automations edit <jobId> --model <provider/model>@<profileId>`. A profile selection does not transfer ownership to a CLI login. Doctor leaves existing bindings unchanged; repeating `doctor --fix` does not repair this mismatch. See [Inference account continuity](/automation/cron-jobs/payloads#inference-account-continuity).
    - A run can finish `ok` after an exec call fails and the agent replies. Check `diagnostic:` in `openclaw automations show <jobId>` or `diagnostics` in run history; unresolved exec failures produce a warning without exposing command arguments.
    - `Automation migration is incomplete; run openclaw doctor --fix` means a converted monitor still has pending migration work. Complete Doctor's reported repair before running it.
    - If a capped job's stored named creator account is unavailable, the run fails before model/tool execution. Job details, run history, and warning logs name the account. Re-add it to the channel configuration, or recreate the automation from the intended account; changing the delivery `--account` does not change creator authority. Legacy jobs without account metadata keep their existing execution policy.

  </Accordion>
  <Accordion title="Job fired but no delivery">
    - A session queue capacity error means the target cannot admit another turn. Let its existing work settle before retrying. Main-session system events stay running until their turn settles; a restart before adoption records one interrupted error without replaying the reminder.
    - Delivery mode `none` means no runner fallback send is expected. The agent can still send directly with the `message` tool when a chat route is available.
    - Delivery target missing/invalid (`channel`/`to`) means outbound was skipped.
    - For Matrix, copied or legacy jobs with lowercased `delivery.to` room IDs can fail because Matrix room IDs are case-sensitive. Edit the job to the exact `!room:server` or `room:!room:server` value from Matrix.
    - Channel auth errors (`unauthorized`, `Forbidden`) mean delivery was blocked by credentials.
    - When the dispatcher records intentional suppression, job state, run history, and finished events include `deliverySuppressionReason` (`empty`, `silent`, `heartbeat`, or `channel_transform`). This is separate from `lastDeliveryError` / `deliveryError`; required delivery failures also log an error when they happen.
    - For text-only isolated announcements, only a completed final that trims to uppercase `NO_REPLY` suppresses the text and fallback queued summary. Lowercase, wrapped forms, and trailing tokens remain visible. See [Silent token suppression](/cli/cron#silent-token-suppression) for the leading-line form and media behavior.
    - If the agent should message the user itself, check that the job has a usable route (`channel: "last"` with a previous chat, or an explicit channel/target).
    - With `delivery.target: "owner"`, no resolved owner DM means delivery is unavailable; it does not skip execution or fall back to the last group conversation. `delivery.directPolicy: "block"` intentionally suppresses DM delivery. Inspect and edit the job's delivery settings.

  </Accordion>
  <Accordion title="Automations or heartbeat appear to prevent /new-style rollover">
    - Daily and idle reset freshness is not based on `updatedAt`; see [Session management](/concepts/session#session-lifecycle).
    - Automation wakeups, heartbeat runs, exec notifications, and gateway bookkeeping may update the session row for routing/status, but they do not extend `sessionStartedAt` or `lastInteractionAt`.
    - For legacy rows created before those fields existed, OpenClaw can recover `sessionStartedAt` from the transcript JSONL session header when the file is still available. Legacy idle rows without `lastInteractionAt` use that recovered start time as their idle baseline.

  </Accordion>
  <Accordion title="Timezone gotchas">
    - Cron expressions without `--tz` use the gateway host timezone.
    - `at` schedules without timezone are treated as UTC.
    - Job `activeHours` has its own timezone (`user`, `local`, or an IANA zone), independent of the cron expression's `--tz`.

  </Accordion>
</AccordionGroup>
