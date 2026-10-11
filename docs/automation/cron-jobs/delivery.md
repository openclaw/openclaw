---
doc-schema-version: 1
summary: "Announce, webhook, and none delivery modes, failure alerts, and output language"
read_when:
  - Routing automation output to a channel or a webhook
  - Tuning failure notifications, thresholds, and cooldowns
  - Fixing an automation that replies in the wrong language
title: "Automation delivery"
sidebarTitle: "Delivery"
---

Where a finished run sends its output, what happens when a run or a delivery fails, and how to pin the reply language. Part of the [Automations](/automation/cron-jobs) guide.

## Delivery and output

| Mode       | What happens                                                       |
| ---------- | ------------------------------------------------------------------ |
| `announce` | Send the result, then record confirmed delivery in the destination |
| `webhook`  | POST finished event payload to a URL                               |
| `none`     | No automatic conversation result or notification                   |

A successful primary webhook run with no nonblank summary intentionally skips the POST and records `deliverySuppressionReason: "empty"`, matching announce delivery's optional-output contract. Execution errors still send the error event even without a summary.

Primary webhooks record delivery after an HTTP 2xx acknowledgment. An HTTP rejection
records **Not delivered**. If the request may have reached the receiver but its
response is lost or times out, delivery stays **Unknown**; the transport does not
retry that ambiguous send. Required delivery also leaves completion unknown,
while best-effort delivery can complete successfully without claiming delivery.

When `gateway.publicOrigin` is configured and the Control UI is enabled, chat
notifications include an `Inspect` link into the Control UI. Command and script
completion announcements open the automation run; isolated agent announcements
open the run's session.

With `announce`, the chat that receives the result owns it. The result is added to the conversation after the channel confirms delivery, using the content actually sent after channel transforms and hooks. OpenClaw writes one assistant message into that chat's transcript so the next reply can use it as context. The result records its job and run; retries do not duplicate it, and OpenClaw waits for active turns before committing it. Destination creation and remembered-route updates happen only after confirmed delivery; newly created destinations inherit the source session's required sandbox policy.

- Delivery to the creating chat writes the result there.
- Delivery to a different chat or topic writes the result **only in the destination**, not in the creating chat.
- With no external route, such as a WebChat-created job, the creating conversation receives the result.
- Jobs created through the CLI or older releases also get a destination transcript when they deliver to a chat, even without a creating conversation.
- `none` and `webhook` do not write a conversation result.

If the destination chat belongs to a different agent, the result is sent but not added to either agent’s conversation.
Channel-native payloads without a text projection are sent without a conversation entry and record a warning.

Execution context is separate: `isolated` starts without conversation history, `current` reads bounded creating-conversation context in a detached run, and `session:<key>` uses a persistent execution session. The private run transcript and tool history are not copied into the destination.
When a persistent execution session is already the destination conversation, its final assistant message is the result; OpenClaw does not append a second copy.

Editing explicit delivery coordinates moves future results to that chat or topic. The captured creating-conversation binding remains immutable; changing the public `sessionKey` does not redirect implicit delivery. For an explicit external destination, starting a new session or resetting the destination chat does not stop delivery: the result goes into that chat's current session. Implicit creator-bound delivery requires the captured creating conversation to exist and match its generation before resolving a remembered external route. Implicit agent-turn announcements retain that generation through sending and recovery; routeless WebChat results also require it at commit. If the creating conversation was deleted or reset, recreate the job or configure an explicit external destination. Command and script announcements keep an already resolved route without a source-generation check, matching their existing behavior. Cancellation does not interrupt the destination's active turn. A verified matching `message` tool send suppresses automatic resend, not the conversation result.

With no external route, the conversation commit itself completes delivery. WebChat receives the committed result immediately and returns the same message from `chat.history` after reconnect. Failed or uncertain external sends do not add a conversation result. Uncertain sends record a warning and are not blindly replayed. If the channel confirms delivery but the conversation write fails, delivery remains successful and the run records a warning that the result was not added to the conversation.

Conversation results and notifications share silent-reply handling. Suppressing a caption preserves attached media, and internal control tokens stay out of history. `none` disables automatic results and notifications; primary `webhook` delivery remains an external-only mode.

Do not set `delivery.channel: "webchat"`: internal conversation coordinates are not channel delivery targets. Leave the external route unset to deliver to the creating WebChat conversation.

<Warning>
  Every outbound automation webhook uses the strict SSRF guard. Loopback,
  private/internal, link-local, and other special-use targets are refused by
  default for primary delivery, completion and failure destinations, and
  failure-alert webhooks.

Allow only the receiver you trust with an exact hostname or IP exemption:

```json5
{
  cron: {
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"],
    },
  },
}
```

Use `dangerouslyAllowPrivateNetwork: true` under `webhookSsrfPolicy` only when
every configured automation webhook may reach trusted private-network
services. Leaving the policy unset keeps strict behavior.
</Warning>

Use `--announce --channel telegram --to "-1001234567890"` for channel delivery. For Telegram forum topics, use `-1001234567890:topic:123`; OpenClaw also accepts the Telegram-owned `-1001234567890:123` shorthand. Direct RPC/config callers may pass `delivery.threadId` as a string or number. Slack/Discord/Mattermost targets use explicit prefixes (`channel:<id>`, `user:<id>`). Matrix room IDs are case-sensitive; use the exact room ID or `room:!room:server` form from Matrix.

For announce delivery in the Control UI Automations editor, choose a channel and an explicit **Account ID** under **Advanced** to see configured conversation targets in the **To** field. Selecting a target preserves your chosen account and does not infer a topic. These configured suggestions apply only to the primary announce destination; failure-alert routing remains separate. You can still enter a target that is not in the suggestions.

On hosts with multiple configured channels, isolated announce jobs created with `automations add|create` or changed with `automations edit` must set `--channel <channel-plugin-id>` unless a provider-prefixed `--to` or a preserved session route selects the channel. Use `--best-effort-deliver` only when unresolved fallback delivery is acceptable; it does not choose a channel, and a delivery failure does not fail the job.

Channel announcements retry transient failures only when no payload may have reached the recipient. A successful retry records delivery without retaining the earlier attempt's error, including with best-effort delivery. Partial or ambiguous sends are not replayed by the announcement retry loop.

When announce delivery uses `channel: "last"` or omits `channel`, a provider-prefixed target such as `telegram:123` can select the channel before the scheduler falls back to session history or a single configured channel. Only prefixes advertised by the loaded plugin are provider selectors. If `delivery.channel` is explicit, the target prefix must name the same provider; `channel: "whatsapp"` with `to: "telegram:123"` is rejected instead of letting WhatsApp interpret the Telegram ID as a phone number. Target-kind and service prefixes (`channel:<id>`, `user:<id>`, `imessage:<handle>`, `sms:<number>`) stay channel-owned target syntax, not provider selectors.

For isolated jobs, chat delivery is shared: if a chat route is available, the agent can use the `message` tool even with `--no-deliver`. If the agent sends to the configured/current target, OpenClaw skips the fallback announce. Otherwise `announce`, `webhook`, and `none` only control what the runner does with the final reply after the agent turn.

Scheduled `message` actions use the Gateway that owns the live run. Keep the
job's account, channel, target, and configured delivery route, but do not supply
per-call `gatewayUrl` or `gatewayToken` fields. Ordinary and standalone message
calls can still use those fields. To recover an existing trusted job whose
prompt or template supplies them, edit only that prompt or template to remove
the two fields, then run the same job again. A Gateway action reports
`Scheduled message actions require the active bound Gateway. Remove per-call
gatewayUrl and gatewayToken fields and retry.` until those fields are removed;
without a scheduler-host binding it reports `Scheduled message actions require
an active bound Gateway.` Run the job on its owning Gateway instead of copying
connection fields into the prompt. The next send then uses the live binding,
including current cancellation and tool-policy withdrawal.

When an agent creates an isolated reminder from an active chat, OpenClaw stores the preserved live delivery target for the fallback announce route. Internal session keys may be lowercase; provider delivery targets are not reconstructed from those keys when current chat context is available.

Implicit announce delivery uses configured channel allowlists to validate and reroute stale targets. DM pairing-store approvals are not fallback automation recipients; set `delivery.to` or configure the channel `allowFrom` entry when a scheduled job should proactively send to a DM.

### Failure notifications

Failure-alert webhooks stay **Unknown** when the request may have reached the
receiver but its response is lost. An explicit HTTP rejection or a failure proven
to precede sending records **Not delivered** and allows the in-app fallback
notification. An unknown outcome does not trigger that fallback.

Execution failures use one scheduler-owned threshold and cooldown policy. A job with an existing failure route is covered by default after 2 consecutive failures with a 1-hour cooldown. The route can be a resolved failure destination or the job's primary announce target. Jobs with no such route stay quiet unless a per-job or global `failureAlert` object explicitly activates the policy.

A one-shot job that is disabled after a permanent failure or exhausted retries notifies on that terminal failure without waiting for the consecutive-failure threshold. Eligible owned jobs receive a repair request in their owner conversation; other jobs use the resolved failure-alert route. The same opt-outs, best-effort policy, and cooldown still apply.

Repeated failures with the same cause form one incident and do not send repeated alerts, even after the cooldown expires or the Gateway restarts. A changed cause or destination can send a new alert after the cooldown. A successful run clears the incident and its cooldown without sending a notification, so the next failure can alert again; the recovery stays visible in automation history. Skipped runs and unknown delivery outcomes do not establish recovery. A successful quiet trigger check can recover a trigger failure, but cannot establish that a previously failed payload has recovered.

Startup recovery reconciles incidents from saved run outcomes without sending historical notifications. A saved successful run clears the old incident even if its job-state update was interrupted, so a later recurrence can alert again.

Failure notification routes resolve in this order:

1. Route fields in the job's `failureAlert` object.
2. `job.delivery.failureDestination`, layered over the destination fields in global `cron.failureAlert` (`mode`, `channel`, `to`, `accountId`). A `cron.failureDestination` block is not read directly; `openclaw doctor --fix` merges it into the global object.
3. The job's primary announce target.

- `job.failureAlert: false` disables execution and required-delivery failure alerts for that job. The auto-disable safety notification remains active.
- Global `cron.failureAlert.enabled: false` disables inherited notifications. A per-job `failureAlert` object explicitly re-enables that job; `enabled: true` explicitly enables the global policy.
- A per-job `failureAlert` object or any global `cron.failureAlert` object activates and tunes the policy even when the job had no existing route.
- `delivery.bestEffort: true` suppresses inherited/default execution-failure alerts. An explicit per-job `failureAlert` remains authoritative.
- `delivery.failureDestination` is only supported on `sessionTarget="isolated"` jobs unless the primary delivery mode is `webhook`.
- Local-provider preflight skips use the normal failure-alert threshold, incident deduplication, and cooldown even when `failureAlert.includeSkipped` is unset or false. Start the provider or check its endpoint in automation history; recurring jobs remain enabled and resume after a later preflight succeeds. When a skipped one-shot has no remaining scheduled run, or the job is paused, restore the provider and use **Run Now** or reschedule the automation. Failure alerts distinguish these cases from jobs with another scheduled run. These skips do not request owner-conversation repair. Explicit alert opt-outs and best-effort policy still apply.
- `failureAlert.includeSkipped: true` opts a job or global automation alert policy into other repeated skipped-run alerts. Skipped runs keep a separate consecutive-skip counter, so they do not affect execution-error backoff.
- `openclaw automations edit` exposes per-job alert tuning: `--failure-alert`/`--no-failure-alert`, `--failure-alert-after <n>`, `--failure-alert-channel`, `--failure-alert-to`, `--failure-alert-cooldown`, `--failure-alert-include-skipped`/`--failure-alert-exclude-skipped`, `--failure-alert-mode`, and `--failure-alert-account-id`.

In the Control UI, custom failure alerts show stored threshold, cooldown, and mode overrides. An omitted channel displays the neutral `last` choice without storing it. Leave the threshold or cooldown blank, or choose **Inherit global setting** for alert mode, to use the Gateway's normal global and routing defaults. Cooldowns accept decimal seconds with millisecond precision, including `0` for no cooldown; for example, `1.001` seconds preserves `1001` milliseconds. Editing other job fields or cloning a job preserves its alert policy, including the skipped-run setting.

A required completion-delivery failure is distinct from an execution failure: a run can record `status: "ok"` with `completionStatus: "failed"`. It does not increment the execution-failure streak or backoff. A delivery-failure alert can notify through a resolved alternate failure destination without waiting for `failureAlert.after`. Repeated delivery failures also form one incident. Alerts for changed failures, including the first delivery failure after an execution alert, honor the shared job/global `failureAlert.cooldownMs` (default 1 hour); suppressed alerts still leave the delivery failure in run history. Skipped runs and quiet trigger checks do not clear a delivery incident or its cooldown; successful completion does. The scheduler never retries the already-failed primary route for an alert.

Chat failure notifications include the run start time in the agent's configured user timezone. When `gateway.publicOrigin` is configured and the Control UI is enabled, they also include an `Inspect` link to the automation run. Webhook message text stays stable; integrations can read the same instant from the structured `runAtMs` field and construct their own links.
Chat notifications show normalized failure causes or allowlisted producer facts for known command and script failures. Arbitrary commands, paths, provider bodies, secrets, delivery errors, skip reasons, diagnostics, and stack/error text remain in automation history. Failure webhooks retain the structured raw error for diagnostic integrations.

#### Owner-conversation repair

Repair is on by default. Upgrading changes what you see for owned automations that alert in chat: the first failure alert of a streak becomes a repair request in the conversation that created the job, and the alert is the fallback. A job with `failureAlert: false` gets neither.

When a job created from a conversation (it has an owner session) reaches its execution-failure alert threshold and the alert would go to chat (`announce` mode), OpenClaw sends a repair request to that owner conversation instead of the alert. The request names the job and includes its schedule, name, payload, and last error; the name, payload, and error are marked as untrusted data. Command jobs and on-exit or stream schedules are operator-only and alert as before.

The conversation handles the request as an ordinary agent turn, as if it had received a message: it runs in that conversation's session, with its transcript, workspace, and tool policy, and the reply goes to the conversation's own route, including its thread or topic. Heartbeat settings do not apply. For recurring jobs, a transient outage gets no reply, a problem it can fix in the workspace (for example the helper script or instructions file the job follows) gets fixed with a one-line note, and otherwise it asks you for exactly what it needs. For a terminal one-shot failure, the agent does the still-needed work or schedules a corrected automation, stays silent if the work is no longer needed, or asks you for what is missing. The request does not carry your sender identity, so owner-only tools such as automation control stay unavailable; changing the job itself happens in your reply turn.

Each failure streak gets at most one repair request, even if its cause changes later. The alert is sent as before when the job has no owner conversation or is excluded from repair. If a one-shot's repair request cannot start, the normal failure alert is sent instead. If the job fails again after the request, you get the normal failure alert, noting that a repair was requested; later alerts in the streak follow the usual cooldown. A successful run clears the streak silently.

While a provider network failure, request timeout, overload, rate limit, or server error gets its quick scheduler re-runs (30 seconds, 1 minute, then 5 minutes, or the job's next scheduled run when that comes first), the alert and the repair request wait. The hold covers at most those three re-runs, whatever the schedule, and never applies when the job has no next run (disabled job, finished one-shot, or a schedule with no future slot). If those re-runs also fail, the normal alert or repair follows with the full failure count; if one succeeds, nothing is sent. Failures the job causes itself are not held: its own execution timeout, script failures, and command-job timeouts usually point at the job, so they alert or repair at the normal threshold.

Script setup refreshes retired tools after a plugin reload before execution begins. If that recovery fails, the alert explains that tools could not be refreshed and the script did not run, then points to automation history and plugin status. A monitor that could not run has no new evidence about the system it monitors.

A provider rejection of an unsupported model records `model_not_found` in the job state and run history. The failure notice points to `openclaw doctor --fix` for provider-declared retirements, or changing/removing the automation's model override. Known retired automation model routes fail before another inference request. Doctor replaces an override with the provider's declared successor when the agent's model policy allows it. Without a declared successor, it clears the override so the job inherits the agent default. If a pinned override's successor is disallowed, Doctor retains the reference and reports the required policy change. A missing account catalog entry or a discovery outage alone does not authorize a migration.

The scheduler also provides a safety backstop. A time-based recurring job is auto-disabled after 10 consecutive execution failures; a successful run resets that streak. One exception: a `delivery.mode: "none"` job with no active failure-alert policy is never auto-disabled by its agent's own `AUTOMATION_FAILED` reports, because it has no one to notify. Those runs still count toward `consecutiveErrors` and the error backoff, and its runtime errors still auto-disable it. On the terminal failure, the richer auto-disable notification replaces the regular threshold alert. Repeated schedule-computation failures auto-disable after 3 errors. The job records `state.autoDisabled.reason` as `consecutive-failures` or `schedule-errors`, and the owning agent receives a notification with a safe cause and recovery command. Raw errors stay in automation history. After fixing the cause, run `openclaw automations enable <jobId>`; enabling clears the recorded reason and failure streaks. Because disabled jobs are hidden by the default list, use `openclaw automations list --all` to inspect them.

### Output language

Automation jobs do not infer a reply language from channel, locale, or previous messages. Put the language rule in the scheduled message or template:

```bash
openclaw automations edit <jobId> \
  --message "Summarize the updates. Respond in Chinese; keep URLs, code, and product names unchanged."
```

For template files, keep the language instruction in the rendered prompt and verify placeholders such as `{{language}}` are filled before the job runs. If the output mixes languages, make the rule explicit, for example: "Use Chinese for narrative text and keep technical terms in English."
