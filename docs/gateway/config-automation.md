---
summary: "Automation config under cron plus the media model template variable surface"
read_when:
  - Scheduling a cron automation
  - Configuring automation failure alerts
  - Looking up media model template variables
title: "Configuration — automations and media template variables"
---

Scheduled automation keys under `cron.*`, plus the media model template variable surface.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Automations (`cron`)

```json5
{
  cron: {
    enabled: true,
    triggers: {
      enabled: true,
    },
    webhookToken: "replace-with-dedicated-token", // optional bearer token for outbound webhook auth
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"], // optional exact exception for a trusted receiver
    },
    sessionRetention: "24h", // duration string ("0h" disables) or false
  },
}
```

- `enabled`: execute stored automation jobs (default: `true`). Set `false` to pause all automation execution without deleting jobs.
- `skipMissedJobs`: skip missed recurring (`cron`/`every`) slots at startup and advance to the next future occurrence (default: `false`). One-shot (`at`) catch-up is unchanged.
- `triggers.enabled`: run event-driven automation triggers (default: `true`). Set `false` to disable condition triggers, script payloads, stream schedules, and event-source admission.
- `sessionRetention`: how long to keep completed isolated automation run sessions before pruning SQLite session rows. Also controls cleanup of archived deleted automation transcripts. Default: `24h`; set `false` or a zero duration such as `"0h"` to disable (negative durations are invalid).
- Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.
- `webhookToken`: bearer token used for automation webhook POST delivery (`delivery.mode = "webhook"`), if omitted no auth header is sent.
- `webhookSsrfPolicy`: shared outbound SSRF policy for primary, completion, failure-destination, and failure-alert webhooks. Private/internal targets are blocked when omitted. Prefer exact `allowedHostnames`; use `dangerouslyAllowPrivateNetwork: true` only for trusted private-network receivers. The narrow fake-IP proxy flags are `allowRfc2544BenchmarkRange` and `allowIpv6UniqueLocalRange`.
- `webhookSsrfPolicy.blockedHostnames`: denies exact hosts and wildcard subdomains before DNS and all allow rules. `*.example.com` excludes the apex; add `example.com` separately to block it. Empty or unset adds no denials.

The `cron` block is strict; `cron.enabled`, `cron.skipMissedJobs`, `cron.triggers`, `cron.webhookToken`,
`cron.webhookSsrfPolicy`, `cron.sessionRetention`, `cron.delivery`, `cron.failureAlert`, `cron.agents`, and `cron.creators` are the only accepted keys. The
retired `cron.webhook` fallback URL is gone: runtime delivery uses per-job
`delivery.mode = "webhook"` plus `delivery.to`, or `delivery.completionDestination`
when preserving announce delivery. `openclaw doctor --fix` strips a leftover
`cron.webhook` from existing config files.

### `cron.delivery`, `cron.agents`, and `cron.creators`

```json5
{
  cron: {
    // Gateway-wide default for jobs that name no route of their own
    delivery: { channel: "telegram", to: "-100123456789", threadId: 1 },
    failureAlert: { channel: "telegram", to: "-100123456789:topic:1" },
    agents: {
      // Jobs owned by this agent use these instead of the Gateway-wide routes
      ops: {
        delivery: { channel: "telegram", to: "-100123456789", threadId: 2 },
      },
    },
    creators: {
      // Jobs created by this Gateway profile use these over agent and Gateway-wide routes
      "profile-id": {
        delivery: { channel: "telegram", to: "-100123456789", threadId: 3 },
      },
    },
  },
}
```

- `delivery`: default announce destination (`channel`, `to`, optional `threadId` and `accountId`; `to` is required). It applies at run time to `announce` jobs that set no `channel` other than `"last"`, no `to`, `threadId`, or `accountId`, and no owner targeting. It replaces the remembered creating-chat route and the single-channel fallback for those jobs. Jobs with `delivery.mode` `"none"` or `"webhook"` never gain a chat destination.
- `agents.<agentId>.delivery`: the same shape, for jobs owned by that agent. The owner is the job's `agentId`, else the agent in its session key, else the default agent. It replaces `cron.delivery` whole; fields are not merged.
- `creators.<profileId>.delivery`: the same shape, for jobs created by that person. The key is the Gateway profile id recorded as the job's creator when it was created: the operator profile that created it, or the human profile that asked an agent to create it. Jobs created before creator recording, and jobs whose creator is channel-only, unknown, an agent with no delegating human, or the system, have no creator default. Keys match exactly. A creator entry wins over the owner agent's entry and replaces it whole.
- Defaults resolve at run time and never rewrite stored jobs. Editing them moves future results of every job that relies on them.
- Config validation rejects a channel in a configured result destination that names no installed channel plugin (built-in aliases such as `gchat` are accepted). An unknown `cron.failureAlert.channel` only warns, so existing configs keep loading. `openclaw doctor` also lists any default destination whose channel plugin is not active.
- `agents` keys that resolve to the same agent id, such as `ops` and `OPS`, are rejected.
- Primary precedence: the job's own routing fields, then `creators.<profileId>.delivery`, then `agents.<agentId>.delivery`, then `delivery`, then the remembered session route.

See [Automation delivery](/automation/cron-jobs/delivery#default-destinations).

### `cron.failureAlert`

```json5
{
  cron: {
    failureAlert: {
      enabled: false,
      after: 2,
      cooldownMs: 3600000,
      includeSkipped: false,
      mode: "announce",
      channel: "last",
      to: "channel:C1234567890",
      accountId: "main",
    },
  },
}
```

`cron.failureAlert` controls alerts for all automations. The per-automation switch overrides `enabled`; it does not override the threshold, cooldown, skip policy, or destination. With no explicit opt-out, alerts are enabled when an eligible owning conversation or a route is available.

- `enabled`: Gateway-wide default for the switch; an explicit job On or Off takes precedence.
- `after`: consecutive failures before an alert (default 1).
- `cooldownMs`: minimum time between different alerts (default 3,600,000). The same unresolved failure repeats at most daily.
- `includeSkipped`: also report consecutive skipped runs (default false). Model-provider preflight outages count even when this is off.
- `mode`, `channel`, `to`, `threadId`, and `accountId`: optional global fallback route for jobs without an eligible owning conversation or when the repair turn cannot start. Without a global route, the job's result destination is used. Do not set a separate route to the same result destination to recover failed sends.

Auto-disable safety notices remain active regardless of this policy.

## Media model template variables

Template placeholders expanded in `tools.media.models[].args`:

| Variable                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `{{Body}}`                  | Full inbound message body                         |
| `{{RawBody}}`               | Raw body (no history/sender wrappers)             |
| `{{BodyStripped}}`          | Body with group mentions stripped                 |
| `{{From}}`                  | Sender identifier                                 |
| `{{To}}`                    | Destination identifier                            |
| `{{MessageSid}}`            | Channel message id                                |
| `{{SessionId}}`             | Current session UUID                              |
| `{{IsNewSession}}`          | `"true"` when new session created                 |
| `{{AttachmentUrl}}`         | Current attachment URL or provider reference      |
| `{{AttachmentPath}}`        | Current attachment local path                     |
| `{{AttachmentContentType}}` | Current attachment MIME content type              |
| `{{AttachmentDir}}`         | Directory containing `AttachmentPath`             |
| `{{AttachmentIndex}}`       | Zero-based source fact index                      |
| `{{Transcript}}`            | Audio transcript                                  |
| `{{Prompt}}`                | Resolved media prompt for CLI entries             |
| `{{MaxChars}}`              | Resolved max output chars for CLI entries         |
| `{{ChatType}}`              | `"direct"` or `"group"`                           |
| `{{GroupSubject}}`          | Group subject (best effort)                       |
| `{{GroupMembers}}`          | Group members preview (best effort)               |
| `{{SenderName}}`            | Sender display name (best effort)                 |
| `{{SenderE164}}`            | Sender phone number (best effort)                 |
| `{{Provider}}`              | Provider hint (whatsapp, telegram, discord, etc.) |

The legacy `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`, and `{{MediaDir}}`
names remain available during the plugin SDK compatibility window but are
deprecated. New configuration should use the `Attachment*` variables.

---
