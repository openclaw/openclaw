---
summary: "Microsoft Graph Mail Wake plugin: mailbox change notifications that wake OpenClaw agent sessions."
read_when:
  - You want new mail in a Microsoft 365 / Outlook mailbox to wake an OpenClaw agent
  - You are configuring the bundled msgraph-mail-wake plugin
title: "Microsoft Graph Mail Wake plugin"
---

The Microsoft Graph Mail Wake plugin watches Microsoft 365 mailboxes through
[Microsoft Graph change notifications](https://learn.microsoft.com/graph/api/subscription-post-subscriptions)
and wakes an OpenClaw agent session when matching mail arrives. It mirrors the
Gmail Pub/Sub wake pattern, but needs no bridge process: Graph posts native
HTTPS webhooks straight to the Gateway.

The plugin runs inside the Gateway process. For a remote Gateway, install and
configure it on that host, then restart the Gateway. It ships with no mailboxes
configured, so it is a no-op until you add at least one mailbox.

## Prerequisites

- A Microsoft Entra app registration with the **application** permission
  `Mail.Read` (admin-consented) if you use client-credentials auth.
- A public HTTPS URL that reaches the Gateway route (for example Tailscale
  Funnel), because Graph calls back over the public internet. The URL path
  must match the configured `path`.
- A reachable agent session to wake (`sessionKey`).

## Configure mailboxes

Set config under `plugins.entries.msgraph-mail-wake.config`:

```json5
{
  plugins: {
    entries: {
      "msgraph-mail-wake": {
        enabled: true,
        config: {
          // Public URL Graph posts notifications to; pathname must match `path`.
          notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
          auth: {
            tenantId: "<entra-tenant-id>",
            clientId: "<entra-app-client-id>",
            clientSecret: { source: "env", provider: "default", id: "GRAPH_CLIENT_SECRET" },
          },
          mailboxes: {
            ops: {
              user: "ops@example.com",
              folder: "inbox", // optional; defaults to the messages root
              wake: {
                sessionKey: "agent:main:main",
                agentId: "main", // optional
              },
            },
          },
        },
      },
    },
  },
}
```

Auth modes (`auth`, exactly one):

- **Client credentials** — `tenantId` + `clientId` + `clientSecret` (secret
  input: string or `{ source, provider, id }` ref). Recommended for
  subscriptions on user mailboxes.
- **Static bearer token** — `bearerToken` (secret input). Useful for manual
  testing; you own token refresh.

Per-mailbox options:

| Option              | Default     | Description                                                                   |
| ------------------- | ----------- | ----------------------------------------------------------------------------- |
| `user`              | (required)  | Mailbox user principal name or object id.                                     |
| `folder`            | unset       | Well-known folder name (for example `inbox`) or folder id to scope the watch. |
| `changeType`        | `"created"` | Graph change types to subscribe to.                                           |
| `fetchMessage`      | `true`      | Fetch `id,subject,receivedDateTime,internetMessageId` to enrich the wake.     |
| `wake.sessionKey`   | (required)  | Session the agent turn is scheduled into.                                     |
| `wake.agentId`      | unset       | Agent id override for the scheduled turn.                                     |
| `wake.deliveryMode` | `"none"`    | `"none"` or `"announce"`.                                                     |

Subscription lifecycle options (`subscription`):

| Option                  | Default | Description                                                                                                                                                                                                                                                            |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expirationMinutes`     | `10000` | Requested lifetime, in minutes. Graph caps mail subscriptions at 10070 minutes in the future; the default sits below that so clock skew never trips the limit, and the plugin adaptively clamps to a tenant-reported ceiling. Graph can also return an earlier expiry. |
| `renewEveryMinutes`     | `1440`  | Renewal interval; renewals PATCH the expiration before it lapses.                                                                                                                                                                                                      |
| `handleLifecycleEvents` | `true`  | Handle Graph lifecycle notifications (`reauthorizationRequired`, `missed`, `subscriptionRemoved`).                                                                                                                                                                     |

## How it works

- On startup the plugin creates one Graph subscription per configured mailbox
  and renews it on an interval. The subscription id and `clientState` live in
  OpenClaw's SQLite plugin state so a restart can renew and authenticate the
  existing provider subscription. Startup fails if that canonical state store
  is unavailable rather than creating an untracked replacement. The durable
  namespace holds exactly 256 enabled mailboxes; configuration above that limit
  fails before any remote subscription is created. Subscriptions for mailboxes
  removed from config are deleted.
- Renewal PATCHes the existing subscription expiry. Callback-route changes also
  PATCH Graph's mutable `notificationUrl` field in place, preserving the
  subscription id and avoiding a duplicate create. Graph does not allow
  `lifecycleNotificationUrl` updates, so that lifecycle callback remains on the
  URL used at creation until the subscription is recreated or replaced; keep
  the previous URL routable during that interval.
- Resource and change-type changes are immutable. Their new tuple differs from
  the existing subscription, so the plugin can conservatively create and
  durably install the replacement before retiring the old identity, with no
  delete/create gap. This immutable-change replacement behavior is verified
  against the documented Graph API contracts but is pending live Microsoft
  Graph tenant validation; no live-tenant test has been run. A subscription
  that Graph reports missing or removed is already absent and is recreated
  directly. Every unavoidable recreation schedules a catch-up resync wake.
- Graph lifecycle notifications are handled explicitly:
  `reauthorizationRequired` renews (reauthorizes) in place, `missed` renews
  and schedules a resync wake so the consumer reconciles the mailbox, and
  `subscriptionRemoved` replaces the subscription with a resync wake.
- Graph first validates the callback URL with a `validationToken` handshake,
  which the plugin answers automatically. Lifecycle notifications arrive on
  the same route.
- Every notification POST is validated against the per-subscription
  `clientState` secret (exact bytes), the subscribed resource collection, and
  the subscribed change types. Validation failures acknowledge with `202` and
  a `blocked` status so Graph does not redeliver poison; transient wake
  failures answer `500` so Graph redelivers — a wake is only deduplicated
  after it is actually scheduled.
- Batched entries are parsed independently. A malformed entry is rejected
  without suppressing valid siblings. If valid work fails transiently, the
  request returns `500`; on Graph's batch retry, already scheduled siblings
  deduplicate and only unfinished work schedules again.
- Duplicate and in-flight redeliveries collapse (`duplicate` / `coalesced`),
  keyed on Graph's top-level unique notification `id` when present. Older
  payloads without that id fall back to the subscription, resource identity,
  and change type. Top-level ids keep distinct deliveries for the same message
  separate; the legacy fallback can collapse an identical resource/change pair
  within the short completed-key TTL.
- A valid notification schedules an immediate, one-shot agent turn
  (cron-backed, `deleteAfterRun`) with a JSON wake message. The notification is
  treated as a wake signal only: with `fetchMessage` the plugin fetches a
  minimal field set itself, but waits at most 750 ms so enrichment cannot exhaust
  Graph's three-second webhook response budget. The message body is never read
  or included.

## Wake payload schema

The plugin passes a JSON string to `scheduleSessionTurn.message`. This is a
stable, versioned payload: consumers must branch on `schemaVersion` first and
then the first-class `kind` discriminator. Version 1 has two variants.

Message notification:

```json
{
  "schemaVersion": 1,
  "source": "msgraph-mail-wake",
  "kind": "message_notification",
  "mailbox": "ops@example.com",
  "folder": "inbox",
  "changeType": "created",
  "messageId": "AAMk...",
  "message": {
    "id": "AAMk...",
    "subject": "Example",
    "receivedDateTime": "2026-07-17T10:00:00Z",
    "internetMessageId": "<example@example.com>"
  },
  "notification": {
    "notificationId": "lsgTZMr9KwAAA",
    "subscriptionId": "00000000-0000-0000-0000-000000000000",
    "resource": "users/.../messages/AAMk...",
    "changeType": "created"
  },
  "instructions": ["..."]
}
```

Mailbox resync:

```json
{
  "schemaVersion": 1,
  "source": "msgraph-mail-wake",
  "kind": "mailbox_resync",
  "mailbox": "ops@example.com",
  "folder": "inbox",
  "resyncReason": "missed_notifications",
  "instructions": ["..."]
}
```

`mailbox` is the configured mailbox `user` (a UPN or Graph object id), not a
value trusted from the webhook. `messageId` is the percent-decoded Graph
message id extracted from the validated resource path. `notification.resource`
is untrusted diagnostic context only; consumers must not use it as authority
for mailbox scope or Graph fetches. `folder`, `notification.notificationId`,
and individual `message` enrichment fields can be absent; `message` is `null`
when enrichment is disabled, unavailable, or fails.

## Delivery guarantees

This plugin matches the existing Gmail hook reliability bar rather than
claiming exactly-once delivery. Provider subscription identity survives a
Gateway restart, but notification claims and completed-key dedupe are bounded
to the current process and a short TTL. Graph is at-least-once, so consumers
must remain idempotent.

Completed notification keys use the same five-minute, 1000-entry process-local
bound as the Gmail hook cache. The oldest completed key is evicted when the
1001st live key is recorded.

Follow-up deferred from this PR: durable notification claims and exactly-once
consumer delivery need a separate design and review. They are not part of the
version 1 contract.

<Warning>
Email content is untrusted input. The wake message includes the subject when
`fetchMessage` is enabled, and a subject can carry prompt-injection attempts.
Point `wake.sessionKey` at a dedicated reader agent with least-privilege tools
for untrusted inboxes, the same posture as
[Gmail hooks](/automation/cron-jobs#gmail-pubsub-integration).
</Warning>

## Related

- [Scheduled tasks (cron, webhooks, Gmail Pub/Sub)](/automation/cron-jobs)
- [Webhooks plugin](/plugins/webhooks)
- [Hooks](/automation/hooks)
