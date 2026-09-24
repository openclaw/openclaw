---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and automations for scheduled work
  - Enabling experimental heartbeat questions with a decision model
title: "Heartbeat"
sidebarTitle: "Heartbeat"
---

<Note>
**Heartbeat is an automation.** See [Automation](/automation) for guidance on
choosing the system-owned monitor or an independently scheduled job.
</Note>

Heartbeat is a system-owned automation that runs **periodic agent turns** in the
main session so the model can surface anything that needs attention without
spamming you. The default `agent` mode keeps this behavior. Experimental
[question mode](/gateway/heartbeat#experimental-question-mode) checks saved
questions with a decision model before starting a scheduled agent turn.

Heartbeat is a scheduled main-session turn - it does **not** create [background task](/automation/tasks) records. Task records are for detached work (ACP runs, subagents, isolated automation jobs).

Under the hood, heartbeat cadence is owned by the Automations scheduler: the gateway maintains one system-owned automation job per heartbeat-enabled agent (visible in `openclaw cron list --all` as `Heartbeat (agent-id)`). Heartbeat config remains the desired-state input, while the persisted monitor schedule owns the actual tick and the runner's later cooldown. The gateway writes config changes through at startup and on config reload. `openclaw doctor --fix` can materialize missing or stale monitor rows before the next gateway start. Edit `agents.*.heartbeat`, not the automation job. If saving monitor rows fails after a config change is accepted, the Gateway keeps the accepted config and reports that recovery is required. Monitor retries use the current accepted config. Rejected changes never become retry targets.

Scheduled heartbeats require automations. When `cron.enabled` is `false` or `OPENCLAW_SKIP_CRON=1`, the gateway logs a startup warning and does not run scheduled heartbeats. Manual and event-driven heartbeat wakes remain available. There is no separate heartbeat fallback timer.

Setting `heartbeat.every: "0m"` disables only the recurring cadence. A targeted event-driven wake can still run one agent turn, such as a background exec completion. It does not create or re-enable a recurring schedule. To keep background exec without automatic completion turns or their model calls, set `tools.exec.notifyOnExit: false`; check `agents.entries.<id>.tools.exec.notifyOnExit` for per-agent overrides. Collect results with `process poll`. See [Background exec notifications](/gateway/background-process#disable-automatic-completion-turns). Tool policy and sandboxing control whether agent turns may execute commands.

Targeted event wakes retain the same per-agent rate limits when recurring cadence is disabled. Those limits are a 30-second minimum between event turns, and a flood guard after five starts within 60 seconds. Deferred work resumes when its guard expires. Config reloads preserve this accounting without enrolling the agent in recurring or broadcast heartbeats.

Transcript markers distinguish `[OpenClaw heartbeat poll]` from an exec completion, cron wake, or session event. Scheduled polls use the configured heartbeat session, which is the agent's main session by default. Targeted completion events return to the session that owns the work. Event markers retain their source provenance without copying internal instructions into chat history. Silent acknowledgment pairs remain hidden.

Troubleshooting: [Automations](/automation/cron-jobs#troubleshooting)

## Quick start (beginner)

<Steps>
  <Step title="Pick a cadence">
    Leave heartbeats enabled (default is `30m`, or `1h` when Anthropic OAuth/token auth is configured, including Claude CLI reuse) or set your own cadence.
  </Step>
  <Step title="Add monitor scratch (optional)">
    Store a tiny checklist in the heartbeat monitor's scratch with `openclaw cron scratch <jobId> --set "..."`.
  </Step>
  <Step title="Decide where heartbeat messages should go">
    Heartbeat alerts go to the operator's direct message by default. Set `commands.ownerAllowFrom` to an array such as `["telegram:123456789"]`, or use a concrete channel `allowFrom`. Wildcard-only allowlists do not identify an owner.
  </Step>
  <Step title="Optional tuning">
    - Use lightweight bootstrap context if heartbeat runs only need the monitor scratch.
    - Enable isolated sessions to avoid sending full conversation history each heartbeat.
    - Restrict heartbeats to active hours (local time).

  </Step>
</Steps>

Example config:

```json5
{
  commands: {
    ownerAllowFrom: ["telegram:123456789"],
  },
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "owner", // default: operator DM from ownerAllowFrom or channel allowFrom
        directPolicy: "allow", // default: allow direct/DM targets; set "block" to suppress
        lightContext: true, // optional: skip workspace bootstrap files for heartbeat runs
        isolatedSession: true, // optional: fresh session each run (no conversation history)
        // activeHours: { start: "08:00", end: "24:00" },
      },
    },
  },
}
```

For a configured Telegram bot, set the owner with a JSON array, even when there is
only one entry. Replace `123456789` with your Telegram user ID and include any
existing owners you want to keep:

```bash
openclaw config set commands.ownerAllowFrom '["telegram:123456789"]'
```

To select a recipient explicitly, set the channel and recipient separately:

```bash
openclaw config set agents.defaults.heartbeat.to '"123456789"'
openclaw config set agents.defaults.heartbeat.target telegram
```

Keep the inner double quotes around the numeric chat ID so `to` is stored as a
string. `heartbeat.target` accepts `owner`, `last`, `none`, or a channel ID such as
`telegram`; `telegram:123456789` belongs in `commands.ownerAllowFrom`, not `target`.

## Defaults

- Interval: `30m`. Applying Anthropic provider defaults bumps this to `1h` when the resolved auth mode is OAuth/token (including Claude CLI reuse), but only while `heartbeat.every` is unset. Set `agents.defaults.heartbeat.every` or per-agent `agents.entries.*.heartbeat.every`. Use `0m` to disable recurring cadence.
- Delivery target: `owner`. OpenClaw uses the first concrete `commands.ownerAllowFrom` entry, then channel `allowFrom`, and never sends this route to a group. Without a resolvable owner DM, ambient polls skip with `reason=no-route`. Set `target: "last"` to follow the most recent conversation, including groups, or `target: "none"` for internal-only runs.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`): `Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.`
- Timeout: unset heartbeat turns use `agents.defaults.timeoutSeconds` when set. Otherwise, they use the heartbeat cadence capped at 600 seconds. Set `agents.defaults.heartbeat.timeoutSeconds` or per-agent `agents.entries.*.heartbeat.timeoutSeconds` for longer heartbeat work. Turns that resume work after a background command completes or process background-task review and blocked-task events use the ordinary agent timeout (48 hours by default); heartbeat cadence and timeout settings do not shorten these continuations. The event must be included in the turn; an isolated monitor does not inherit the budget of work pending in its base session.
- The heartbeat prompt is sent **verbatim** as the scheduled user message. Heartbeat runs use the same system prompt as ordinary agent turns. There is no heartbeat-specific system-prompt section.
- When recurring heartbeats are disabled with `0m`, the automation job stays but is disabled. Its monitor scratch is retained for when you re-enable the cadence. Targeted event-driven wakes remain available.
- When automations are disabled entirely, scheduled heartbeats do not run even if heartbeat cadence remains enabled.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone. Outside the window, heartbeats are skipped until the next tick inside the window.
- Scheduled heartbeats defer while the main queue or automation work is active or queued, while any reply or embedded run for the same agent is active, and while the resolved target session has active or queued work. An event-free plain monitor poll that has not begun preparation is recorded as skipped and waits for its next persisted cadence tick, instead of keeping a running automation open behind busy work. Wakes carrying queued events or scheduled tasks, and work already admitted or retained after execution, still retry. Immediate and manual wakes bypass the broad same-agent active-run check, but still honor the main, automation, and target-session busy guards. Sibling agents do not pause each other.
- A targeted background-command completion waits for its own session to become free, including final-delivery recovery, but does not wait for unrelated sessions or automations. A completion coalesced with scheduled heartbeat work retains the scheduled work's busy guards.

## What the heartbeat prompt is for

The default prompt is intentionally narrow: follow the heartbeat monitor scratch
context when provided, keep recurring work in automation jobs, and reply
`NO_REPLY` when nothing needs attention. It explicitly tells the agent
**not** to infer or repeat old tasks from prior chats, so a default install stays
quiet instead of rehashing stale conversation context.

Proactive heartbeat behavior is opt-in:

- **Recurring checks**: create [automations](/automation/cron-jobs) for inbox
  review, calendar sweeps, or queued follow-ups. Each job executes its configured
  payload on its own schedule. The default heartbeat does not infer recurring
  work from prior chats.
- **Human check-in**: create a scheduled job if you want an occasional
  lightweight "anything you need?" message, and constrain its schedule to avoid
  night-time pings in your configured local timezone (see
  [Timezone](/concepts/timezone)).

Heartbeat can react to completed [background tasks](/automation/tasks), but a heartbeat run itself does not create a task record.

If you want a heartbeat to do something very specific (e.g. "check Gmail PubSub stats" or "verify gateway health"), set `agents.defaults.heartbeat.prompt` (or `agents.entries.*.heartbeat.prompt`) to a custom body (sent verbatim).

## Experimental question mode

Set `heartbeat.mode: "questions"` to evaluate agent-managed yes/no questions
before scheduled heartbeat turns. Questions are answered by the
[decision model](/concepts/decision-models) you selected for the agent, for
example Jev through the [TypeSafe AI plugin](/plugins/typesafe#enable-and-configure)
or a local [ONNX](/plugins/onnx) classifier. Question mode also requires the
[Decision assistance](/concepts/experimental-features#decision-assistance) Labs
opt-in:

```json5
{
  agents: {
    ownership: "explicit",
    defaults: {
      experimental: { decisionAssistance: true },
    },
    entries: {
      assistant: {
        decisionModel: "typesafe/jev-1.13.0",
        heartbeat: { mode: "questions", every: "30m" },
      },
    },
  },
}
```

You can also set `decisionModel` and `heartbeat.mode` under `agents.defaults`;
the agent-level `decisionModel` wins, and an explicit empty per-agent value
disables question mode for that agent. Without an effective decision model or
the Labs opt-in, the agent keeps ordinary heartbeat turns and does not receive
the `heartbeat_questions` tool. The ordinary chat model still performs the work
when a question triggers a turn; `heartbeat.model` continues to override that
agent model if configured.

Ask the agent in a normal conversation to save a group of checks, for example:
“Check the latest CI runs for my repository and wake up if a run failed. Keep
pull request checks in a separate group.” The agent uses `heartbeat_questions`
to manage its own monitor's groups. Groups belong to the agent and are shared
across its sessions; access follows the agent's tool policy.

| Action   | Fields                        | Effect                                         |
| -------- | ----------------------------- | ---------------------------------------------- |
| `list`   | None                          | Read saved groups, commands, and questions.    |
| `upsert` | `id`, `commands`, `questions` | Add a group or replace the entire group by ID. |
| `remove` | `id`                          | Remove a saved group.                          |

Each group has shell commands that collect its state and questions about that
state. For example, the agent can make these two tool calls after replacing
`OWNER/REPO` with your repository:

```json
{
  "action": "upsert",
  "id": "ci",
  "commands": ["gh run list --repo OWNER/REPO --limit 5 --json status,conclusion,displayTitle"],
  "questions": [{ "id": "failed", "question": "Has any listed CI run completed with a failure?" }]
}
```

```json
{
  "action": "upsert",
  "id": "pull-requests",
  "commands": [
    "gh pr list --repo OWNER/REPO --state open --limit 10 --json number,title,isDraft,reviewDecision"
  ],
  "questions": [
    {
      "id": "changes",
      "question": "Does any listed non-draft pull request have reviewDecision CHANGES_REQUESTED?"
    }
  ]
}
```

These examples require an authenticated GitHub CLI. Use commands that observe
state, with filters and explicit output limits. Commands run under the agent's
existing execution policy; saving a group does not authorize otherwise-blocked
execution. Do not include credentials in command output: selecting a hosted
decision model sends the collected state to that provider.

OpenClaw evaluates each group in a separate decision request. Each request
includes that group's command outputs, the current time, full heartbeat notes,
and a shared bounded slice of recent conversation: up to 6 visible user and
assistant messages from a recent 8 KiB transcript window. Other groups' command
outputs are excluded. Split unrelated sources into separate groups so each
request contains only the command evidence its questions need.

Each monitor supports up to 16 groups, each with up to 5 commands and 32
questions. Group and question IDs contain 1–64 letters, digits, underscores, or
hyphens; question text is limited to 2,000 characters. The complete serialized
decision request for each group, including questions and shared context, is
capped at 24 KiB. Commands have a combined output limit of 16 KiB and a 30-second
budget per group. These are OpenClaw limits, not the provider's token limit.
Oversized or truncated output falls back to the ordinary agent instead of being
treated as evidence for a no answer. The fallback asks the agent to reduce
command output, split groups, or shorten heartbeat notes; the conversation
window is already bounded.

Each question is evaluated as a Boolean probability:

- Any `probabilityTrue >= 0.5` starts one ordinary heartbeat agent turn.
- All answers in all groups below `0.5` skip the agent turn.
- An empty group list skips the scheduled turn without commands or a decision request.
- A failed or timed-out command, unavailable decision model, failed request,
  or unusable result falls back to the ordinary heartbeat turn. Cancellation
  does not start fallback work.

Triggered turns receive the evaluated evidence. Fallback turns receive the
registered checks and available evidence so the agent can investigate.
Manual wakes, queued events, due task wakes, and completion notifications bypass
the question check. Existing scheduling and eligibility guards still apply.
A yes answer starts the usual agent; it does not bypass tool policy or approvals.

Groups persist alongside the notes in the existing monitor scratch storage.
Agent updates to heartbeat notes preserve the groups. Set `mode: "agent"`
to restore ordinary heartbeats without deleting the saved groups or notes.
Removing `mode` also restores the default unless the agent inherits `questions`
from `agents.defaults`. Existing configurations keep ordinary
heartbeats and need no migration to continue working.

## Response contract

- If nothing needs attention, reply with **`NO_REPLY`**.
- Heartbeat runs may instead call `heartbeat_respond` with `notify: false` for no visible update, or `notify: true` plus `notificationText` for an alert. When present, the structured tool response takes precedence over the text fallback.
- A meaningful `heartbeat_respond` result with `notify: false` remains silent but is remembered as bounded internal context for the next user turn in that session. A generated `notify: true` alert whose delivery is blocked or unconfirmed is also recorded, including its alert text and delivery reason. This is the latest outcome for the session, not an alert history or exact-delivery replay queue. `no_change` acknowledgments and confirmed visible notifications are not stored this way.
- Existing custom prompts may still return the legacy `HEARTBEAT_OK` acknowledgment. OpenClaw accepts it at the **start or end** of a reply and drops the reply when its remaining content is at most 300 characters. The suppression budget is fixed.
- A legacy `HEARTBEAT_OK` in the **middle** of a reply is not treated specially.
- For alerts, return only the alert text. Do not include a silent acknowledgment.
- Delivery selects the last outbound-capable non-reasoning payload. Separate reasoning or thinking payloads remain internal. A reasoning-only result produces no alert.
- Tool error warnings remain enabled during heartbeat turns.
- `openclaw system heartbeat last --json` reports a confirmed message-tool send to the heartbeat recipient as `sent`, without sending another acknowledgment.
- If the heartbeat starts background work without sending an update, its status event reports `skipped` with reason `background-work`. Check the task for completion. This is not an all-clear acknowledgment.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped and logged. A message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        lightContext: false, // default: false; true skips workspace bootstrap files for heartbeat runs
        isolatedSession: false, // default: false; true runs each heartbeat in a fresh session (no conversation history)
        target: "owner", // default | options: last | none | <channel id>
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.",
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` sets global heartbeat behavior.
- `agents.entries.*.heartbeat` merges on top. If any agent has a `heartbeat` block, **only those agents** run heartbeats.
- Ambient ownership resolves through `agents.defaults.heartbeat.agentId`, `agents.defaults.systemAgent.agentId`, the legacy default owner, then the sole agent. When no per-agent or default heartbeat block applies and that chain leaves a multi-agent roster ownerless, heartbeats stay disabled and emit validation and Gateway warnings.
- `channels.defaults.heartbeatVisibility` sets visibility defaults for all channels.
- `channels.<channel>.heartbeatVisibility` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeatVisibility` (multi-account channels) overrides per-channel settings.

### Per-agent heartbeats

If any `agents.entries.*` entry includes a `heartbeat` block, **only those agents** run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat` (so you can set shared defaults once and override per agent).

Example: two agents, only the second agent runs heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "owner", // default: operator DM
      },
    },
    entries: {
      main: { default: true },
      ops: {
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          timeoutSeconds: 45,
          prompt: "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.",
        },
      },
    },
  },
}
```

### Active hours example

Restrict heartbeats to business hours in a specific timezone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "owner", // default: operator DM
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.

### 24/7 setup

If you want heartbeats to run all day, use one of these patterns:

- Omit `activeHours` entirely (no time-window restriction, which is the default behavior).
- Set a full-day window: `activeHours: { start: "00:00", end: "24:00" }`.

<Warning>
Do not set the same `start` and `end` time (for example `08:00` to `08:00`). That is treated as a zero-width window, so heartbeats are always skipped.
</Warning>

### Multi-account example

Use `accountId` to target a specific account on multi-account channels like Telegram:

```json5
{
  agents: {
    entries: {
      ops: {
        default: true,
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // optional: route to a specific topic/thread
          accountId: "ops-bot",
        },
      },
    },
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Field notes

<ParamField path="mode" type="string" default="agent">
  `agent` runs ordinary heartbeat turns. Experimental `questions` evaluates saved
  groups of command outputs and questions with the agent’s decision model before scheduled turns.
</ParamField>
<ParamField path="every" type="string">
  Heartbeat interval (duration string, default unit minutes).
</ParamField>
<ParamField path="model" type="string">
  Optional model override for heartbeat runs (`provider/model`).
</ParamField>
<ParamField path="lightContext" type="boolean" default="false">
  When true, heartbeat runs use lightweight bootstrap context and skip workspace bootstrap files. Monitor scratch is injected by the heartbeat runner either way.
</ParamField>
<ParamField path="isolatedSession" type="boolean" default="false">
  When true, each heartbeat runs in a fresh session with no prior conversation history. Uses the same isolation pattern as automation jobs with `sessionTarget: "isolated"`. Dramatically reduces per-heartbeat token cost. Combine with `lightContext: true` for maximum savings. Delivery routing and conversation context still follow the selected conversation, including its channel, account, and topic. A background command's completion keeps its original event route if that conversation later moves. It does not borrow the new room's description or activation policy.
</ParamField>
<ParamField path="session" type="string">
  Optional session key for heartbeat runs.

- `main` (default): agent main session.
- Explicit session key (copy from `openclaw sessions --json` or the [sessions CLI](/cli/sessions)).
- Session key formats: see [Sessions](/concepts/session) and [Groups](/channels/groups).

</ParamField>
<ParamField path="target" type="string">
- `owner` (default): deliver to the first resolvable operator DM from `commands.ownerAllowFrom`, then channel `allowFrom`. This route never resolves to a group or channel.
- `last`: explicitly follow the last used external conversation, including groups and channels.
- explicit channel: any configured channel or plugin id, for example `discord`, `matrix`, `telegram`, or `whatsapp`.
- `none`: run the heartbeat for internal state only. **Do not deliver** it externally.

For an explicit Telegram recipient, use `target: "telegram"` and `to: "123456789"`.
The `target` field does not accept a combined channel-and-recipient value such as
`"telegram:123456789"`.

</ParamField>
<ParamField path="directPolicy" type='"allow" | "block"' default="allow">
  Controls direct/DM delivery behavior. `allow`: allow direct/DM heartbeat delivery. `block`: suppress direct/DM delivery (`reason=dm-blocked`).

</ParamField>
<ParamField path="to" type="string">
  Recipient for an explicit channel target (for example, E.164 for WhatsApp or a Telegram chat id). `owner` and an unset target ignore `to`. For Telegram topics/threads, use `<chatId>:topic:<messageThreadId>`.

</ParamField>
<ParamField path="accountId" type="string">
  Optional account id for multi-account channels. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts. Otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.

</ParamField>
<ParamField path="prompt" type="string">
  Overrides the default prompt body (not merged).

</ParamField>
<ParamField path="timeoutSeconds" type="number" default="global timeout or min(every, 600)">
  Maximum seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use `agents.defaults.timeoutSeconds` when set, otherwise the heartbeat cadence capped at 600 seconds.
  Exec-completion continuations use the ordinary agent timeout instead, including an explicit `agents.defaults.timeoutSeconds` value of `0` for no timeout.

</ParamField>
<ParamField path="activeHours" type="object">
  Restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive, with `00:00` for start-of-day), `end` (HH:MM exclusive, with `24:00` allowed for end-of-day), and optional `timezone`.

- Omitted or `"user"`: uses your `agents.defaults.userTimezone` if set, otherwise falls back to the host system timezone.
- `"local"`: always uses the host system timezone.
- Any IANA identifier (e.g. `America/New_York`): used directly. If invalid, falls back to the `"user"` behavior above.
- `start` and `end` must not be equal for an active window. Equal values are treated as zero-width (always outside the window).
- Outside the active window, heartbeats are skipped until the next tick inside the window.

</ParamField>

<Note>
Heartbeat configuration is strict: only the fields listed above are accepted. Acknowledgment suppression, reasoning visibility, system-prompt guidance, busy deferral, and tool-error warning behavior are fixed runtime policies rather than heartbeat configuration fields.
</Note>

## Delivery behavior

<AccordionGroup>
  <Accordion title="Session and target routing">
    - Heartbeats run in the agent's main session by default (`agent:<id>:main`), or `global` when `session.scope = "global"`. Set `session` to override to a specific channel session (Discord/WhatsApp/etc.).
    - `session` only affects the run context. Delivery is controlled by `target` and `to`.
    - The default `owner` target chooses an explicitly configured owner identity. It reuses the exact account/thread only when the session's last route is a direct chat to that owner.
    - A wake that carries a channel and recipient uses that named origin before owner discovery. This event destination can be a group because it is explicit, not inferred.
    - To deliver to a specific channel/recipient, set a channel `target` plus `to`. `target: "last"` is an explicit opt-in to the last external conversation, including groups.
    - Heartbeat deliveries allow direct/DM targets by default. Set `directPolicy: "block"` to suppress direct-target sends while still running the heartbeat turn.
    - Scheduled heartbeats skip when the main queue or automation work is busy, any reply or embedded run for the same agent is active, or the resolved target session has active or queued work. Event-free plain monitor polls that have not begun preparation wait for the next persisted cadence tick. Queued events, scheduled tasks, and work already admitted or retained after execution keep their retries. Immediate and manual wakes bypass only the broad same-agent active-run precheck.
    - If `owner` has no concrete, DM-capable owner or configured channel, the poll is skipped as `reason=no-route` before the agent runs. Explicit `last` also skips when the session has no external route.
    - The first alert delivered by the implicit `owner` default explains periodic checks and how to choose `target: "none"`. Later alerts omit that line.

  </Accordion>
  <Accordion title="Visibility and skip behavior">
    - If the heartbeat turn fails before the model can reply, the failure notice names the reason whenever OpenClaw itself refused the run. One example is a session runtime that is still busy in another runner. Raw provider or runtime errors stay behind the verbose failure-detail setting (`/verbose on` or `/verbose full`), as in normal chats.
    - If `showOk`, `showAlerts`, and `useIndicator` are all disabled, the run is skipped up front as `reason=alerts-disabled`.
    - If only alert delivery is disabled, OpenClaw can still run the heartbeat, update due-task timestamps, restore the session idle timestamp, and suppress the outward alert payload.
    - If the channel readiness check blocks an alert, OpenClaw records the non-delivery. It retries the heartbeat after a one-minute grace period, without consuming its cadence slot. This retry runs the heartbeat again. It does not replay the exact earlier alert. Once a send enters the durable delivery queue, that queue owns transport retries.
    - If the resolved heartbeat target supports typing, OpenClaw shows typing while the heartbeat run is active. This uses the same target the heartbeat would send chat output to, and it is disabled by `typingMode: "never"`.

  </Accordion>
  <Accordion title="Session lifecycle and audit">
    - Heartbeat-only replies do **not** keep the session alive. Heartbeat metadata may update the session row, but idle expiry uses `lastInteractionAt` from the last real user/channel message, and daily expiry uses `sessionStartedAt`.
    - Control UI and WebChat history hide heartbeat prompts and OK-only acknowledgments. The underlying session transcript can still contain those turns for audit/replay.
    - Detached [background tasks](/automation/tasks) can enqueue a system event and wake heartbeat when the main session should notice something quickly. That wake does not make the heartbeat run a background task.

  </Accordion>
</AccordionGroup>

## Visibility controls

By default, quiet heartbeat acknowledgments are suppressed while alert content is delivered. You can adjust this per channel or per account:

```json5
{
  channels: {
    defaults: {
      heartbeatVisibility: {
        showOk: false, // Hide HEARTBEAT_OK (default)
        showAlerts: true, // Show alert messages (default)
        useIndicator: true, // Emit indicator events (default)
      },
    },
    telegram: {
      heartbeatVisibility: {
        showOk: true, // Show OK acknowledgments on Telegram
      },
    },
    whatsapp: {
      accounts: {
        work: {
          heartbeatVisibility: {
            showAlerts: false, // Suppress alert delivery for this account
          },
        },
      },
    },
  },
}
```

Precedence: per-account → per-channel → channel defaults → built-in defaults.

### What each flag does

- `showOk`: sends a `HEARTBEAT_OK` acknowledgment when the model returns an OK-only reply.
- `showAlerts`: sends the alert content when the model returns a non-OK reply.
- `useIndicator`: emits indicator events for UI status surfaces.

If **all three** are false, OpenClaw skips the heartbeat run entirely (no model call).

### Per-channel vs per-account examples

```json5
{
  channels: {
    defaults: {
      heartbeatVisibility: {
        showOk: false,
        showAlerts: true,
        useIndicator: true,
      },
    },
    slack: {
      heartbeatVisibility: {
        showOk: true, // all Slack accounts
      },
      accounts: {
        ops: {
          heartbeatVisibility: {
            showAlerts: false, // suppress alerts for the ops account only
          },
        },
      },
    },
    telegram: {
      heartbeatVisibility: {
        showOk: true,
      },
    },
  },
}
```

### Common patterns

| Goal                                     | Config                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Default behavior (silent OKs, alerts on) | _(no config needed)_                                                                               |
| Fully silent (no messages, no indicator) | `channels.defaults.heartbeatVisibility: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (no messages)             | `channels.defaults.heartbeatVisibility: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs in one channel only                  | `channels.telegram.heartbeatVisibility: { showOk: true }`                                          |

## Monitor scratch (optional)

Each heartbeat automation job owns a private monitor scratch stored in the shared state database. Think of it as your "heartbeat checklist": small, stable, and safe to consider every 30 minutes. When scratch exists, its content is appended to the heartbeat prompt.

Manage it with the automations CLI (the job id comes from `openclaw cron list --all`):

```bash
openclaw cron scratch <jobId>                 # print the current scratch
openclaw cron scratch <jobId> --set "..."     # replace it with exact text
openclaw cron scratch <jobId> --file notes.md # replace it from a file (- for stdin)
openclaw cron scratch <jobId> --unset         # remove it
```

Writes are compare-and-swap guarded: pass `--expected-revision <n>` to fail instead of overwriting a concurrent edit. Scratch is capped at 256 KiB and never appears in `cron list`/`cron runs` output.

The agent can also update its own scratch: during a heartbeat turn, `heartbeat_respond` accepts an optional `scratch` string that fully replaces the monitor's scratch for future heartbeats.

<Note>
**Migrating from HEARTBEAT.md or config-only cadence?** Run `openclaw doctor --fix`. Doctor first creates or updates the system-owned monitor rows from `agents.*.heartbeat`. It then imports each agent's workspace `HEARTBEAT.md` into the monitor scratch. It converts any valid legacy `tasks:` entries into automation jobs. It archives the original under the state directory (`backups/heartbeat-migration/`) and removes the file. Runtime heartbeat instructions come from database scratch only. The runtime never reads `HEARTBEAT.md`.

If the workspace and state directory are on different filesystems, Doctor keeps the original file in a private `HEARTBEAT.md.doctor-archived.*` directory beside its former location. The state-directory backup remains an immutable snapshot. Later writes through an already-open file descriptor remain recoverable in the workspace archive.
</Note>

OpenClaw skips the heartbeat run to save API calls when scratch exists but is effectively empty. Effectively empty means only blank lines, Markdown or HTML comments, Markdown headings like `# Heading`, fence markers, or empty checklist stubs. That skip is reported as `reason=empty-heartbeat-file`. Scheduled interval monitors without due tasks resolve this skip before deferring behind busy execution queues. If no scratch exists, the heartbeat still runs and the model decides what to do.

Keep it tiny (short checklist or reminders) to avoid prompt bloat.

Example scratch:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it's daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Schedule recurring checks with automations

Monitor scratch is prompt context, not a scheduler. Create each recurring check as an [automation job](/automation/cron-jobs) so it has its own cadence, enable/disable state, and run history. Automation jobs can still target the main session when the check should use the normal conversation context.

Older scratch may contain a structured `tasks:` block. Run `openclaw doctor --fix` once after upgrading: Doctor converts every valid entry into an independently scheduled automation job. It preserves each entry's interval and previous last-run timing. It removes the retired block and keeps the surrounding scratch prose. Runtime heartbeat turns do not parse `tasks:` text as schedules.

Doctor-created heartbeat task jobs keep heartbeat active-hours, cooldown, flood, and busy guards. Jobs due together can coalesce into one heartbeat turn. An occurrence outside active hours is skipped and tried again at its next scheduled occurrence.

### Can the agent update its scratch?

Yes. During a heartbeat turn, the agent can pass a `scratch` value to `heartbeat_respond` to fully replace the monitor scratch for future heartbeats. You can also ask it in a normal chat to run `openclaw cron scratch <jobId> --set ...`, or edit the scratch yourself with the same command. Manage recurring schedules with automations instead of writing scheduler syntax into scratch.

<Warning>
Don't put secrets (API keys, phone numbers, private tokens) into monitor scratch - it becomes part of the prompt context.
</Warning>

## Manual wake (on-demand)

Use `openclaw system event` to enqueue a system event and optionally trigger an immediate heartbeat:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

| Flag                         | Description                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `--text <text>`              | System event text (required).                                                                    |
| `--mode <mode>`              | `now` runs an immediate heartbeat; `next-heartbeat` (default) waits for the next scheduled tick. |
| `--session-key <sessionKey>` | Target a specific session for the event; defaults to the agent's main session.                   |
| `--json`                     | Output JSON.                                                                                     |

If no `--session-key` is given and multiple agents have `heartbeat` configured, `--mode now` runs each of those agent heartbeats immediately.

Broadcast completion reports an agent failure even if another agent succeeded or was quietly skipped. Busy retries and guarded deferrals keep their existing retry behavior.

Related heartbeat controls in the same CLI group:

```bash
openclaw system heartbeat last     # show the last heartbeat event
openclaw system heartbeat enable   # enable heartbeats
openclaw system heartbeat disable  # disable heartbeats
```

## Cost awareness

By default, heartbeats run full agent turns. Shorter intervals burn more tokens. To reduce cost:

- Try [experimental question mode](/gateway/heartbeat#experimental-question-mode) for checks answerable from small, focused command outputs.
- Use `isolatedSession: true` to avoid sending full conversation history (~100K tokens down to ~2-5K per run).
- Use `lightContext: true` to skip workspace bootstrap files for heartbeat runs.
- Set a cheaper `model` (e.g. `ollama/llama3.2:1b`).
- Keep the monitor scratch small.
- Set `target: "none"` explicitly if you only want internal state updates.

## Context overflow after heartbeat

Heartbeats preserve the shared session's existing runtime model after the run completes. A heartbeat that switched a session to a smaller local model can therefore leave that model in place for the next main-session turn. An Ollama model with a 32k window is one example. That next turn may report context overflow. If the session's last runtime model also matches configured `heartbeat.model`, OpenClaw's recovery message calls out heartbeat model bleed as the likely cause. The message also suggests a fix.

To avoid this, use `isolatedSession: true` to run heartbeats in a fresh session. You can combine it with `lightContext: true` for the smallest prompt. Otherwise choose a heartbeat model with a context window large enough for the shared session.

## Related

- [Automation](/automation) - all automation mechanisms at a glance
- [Background Tasks](/automation/tasks) - how detached work is tracked
- [Timezone](/concepts/timezone) - how timezone affects heartbeat scheduling
- [Troubleshooting](/automation/cron-jobs#troubleshooting) - debugging automation issues
