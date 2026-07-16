---
summary: "AgentMail email channel setup, verified ingress, sender allowlisting, threading, and attachments"
read_when:
  - You want OpenClaw to receive and reply to email through AgentMail
  - You need webhook or WebSocket AgentMail setup
title: "AgentMail"
---

AgentMail connects one OpenClaw channel account to one AgentMail inbox. Incoming email is durably queued, hydrated from AgentMail's REST API, checked against a sender allowlist, and dispatched as a threaded agent turn. Replies are always bound to the incoming message; callers cannot start a thread or choose recipients.

Status: official plugin, installed separately. Requires OpenClaw `2026.7.2` or newer.

## Install

```bash
openclaw plugins install @openclaw/agentmail
```

## Configure webhook ingress

Create an AgentMail inbox and a `message.received` webhook subscription whose URL reaches the exact Gateway path. OpenClaw does not create or manage production AgentMail webhooks.

```json5
{
  channels: {
    agentmail: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        default: {
          apiKey: { source: "env", provider: "default", id: "AGENTMAIL_API_KEY" },
          inboxId: "inbox_...",
          webhookSecret: {
            source: "env",
            provider: "default",
            id: "AGENTMAIL_WEBHOOK_SECRET",
          },
          webhookPath: "/webhooks/agentmail",
          dmPolicy: "allowlist",
          allowFrom: ["sender@example.com"],
          mediaMaxMb: 20,
        },
      },
    },
  },
}
```

Configure the AgentMail webhook as:

```text
POST https://gateway.example.com/webhooks/agentmail
event type: message.received
```

The plugin verifies the Svix signature over the untouched request body before parsing it. It accepts at most 1 MiB of webhook data and acknowledges only after the shared SQLite ingress queue commits the event. If admission is temporarily unavailable, it returns `503` for provider retry and also starts bounded REST recovery from its persisted cursor. Expose only the configured webhook path through your reverse proxy.

For named accounts, the default path is `/webhooks/agentmail/<accountId>`. Set an explicit `webhookPath` when your public routing requires a different path. Paths must be unique across accounts.

## WebSocket alternative

Omit `webhookSecret` to use AgentMail WebSocket ingress:

```json5
{
  channels: {
    agentmail: {
      apiKey: { source: "env", provider: "default", id: "AGENTMAIL_API_KEY" },
      inboxId: "inbox_...",
      dmPolicy: "allowlist",
      allowFrom: ["sender@example.com"],
    },
  },
}
```

Webhook and WebSocket are configuration alternatives. The plugin does not switch to WebSocket because a configured webhook has been quiet or unreachable. WebSocket mode re-subscribes on every connection and periodically requests REST recovery from the plugin's durable cursor, including when the socket appears open but has stopped delivering events. The recovery path paginates authoritative `received` messages from AgentMail with a short overlap window. The shared message digest deduplicates overlap with live WebSocket or webhook events, closing restart, connection-gap, and exhausted-provider-retry windows without replaying pre-install mailbox history.

## Sender security

`dmPolicy` defaults to `allowlist`. Missing or empty `allowFrom` denies every sender. Entries are exact mailbox addresses, normalized case-insensitively after authoritative REST hydration and single-mailbox parsing.

To intentionally accept every sender, configure both values explicitly:

```json5
{
  channels: {
    agentmail: {
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

Every message is authorized independently, even when several people participate in the same AgentMail thread. Ambiguous or missing `From` mailboxes are rejected without starting an agent turn.

## Reply-only delivery and threads

The only outbound target is:

```text
message:<messageId>
```

The triggering message ID is fixed for the whole turn. The outbound adapter accepts only the implicit source-message binding supplied by the active inbound turn; proactive sends, explicit reply overrides, and attempts to switch to another message ID are rejected. OpenClaw does not keep a thread-to-latest-message pointer. Before each send or recovery attempt, the plugin hydrates that message again, parses its authoritative `From`, and reapplies the account allowlist. It then sets `to` to that authorized address, sets `replyAll: false`, omits `cc`, `bcc`, and `replyTo`, and uses an idempotency key derived from OpenClaw's durable delivery queue record. An untrusted `Reply-To` header therefore cannot redirect the agent response, and a multi-recipient email never replies to the other recipients.

Sessions are keyed by OpenClaw account, AgentMail inbox, and AgentMail thread ID. Participants share the thread context, while sender authorization remains per message.

## Message bodies and attachments

The REST-hydrated extracted text is preferred because AgentMail removes quoted reply and forward history from it. Extracted HTML is the next choice and is converted through OpenClaw's shared HTML-to-text helpers. Full plain text and HTML are fallbacks when AgentMail did not provide extracted content. When no body is available, the hydrated subject becomes the message. Transport event bodies are never used as authoritative content.

Inbound attachment metadata is hydrated with AgentMail's positional API, and its short-lived `downloadUrl` is loaded through OpenClaw's bounded, SSRF-aware media path. Inline/CID parts are skipped. Per-file and aggregate limits use `mediaMaxMb` (default 20 MiB). All accepted attachments must download before the agent turn starts; a transient download failure dispatches nothing and leaves the durable event retryable. A deterministic size-policy rejection omits the complete attachment set, adds an omission notice, and still dispatches the authoritative body or subject.

Outbound text and attachments are normalized and loaded before one AgentMail reply request. `MEDIA:` directives and Markdown images are extracted into attachments instead of leaking transport tokens into the email body. The message adapter asks core to preserve the complete media payload, so ordinary attachment replies use the same atomic path instead of one send per media URL. Replies are not streamed or split into separate email messages.

## Durability

Webhook, live WebSocket, and REST catch-up records share a digest of account ID, inbox ID, and message ID, so retries, reconnects, overlap, and transport changes deduplicate to one turn. OpenClaw persists restart-recovery delivery state before agent or tool execution, and the plugin durably adopts the turn by completing its ingress row at that boundary. A fresh turn does not start if completion fails. If an active turn was already irrevocably queued, ingress retries only the completion marker and never redispatches it. After successful adoption, core recovery owns interrupted delivery.

Pending ingress records use a 30-day inactivity retention window, failed records use 30 days, and completed records use 7 days. AgentMail uses an explicit 450-record admission limit that never evicts accepted pending mail. Dispatch failures remain pending and retry with bounded exponential backoff instead of being converted into a successful duplicate marker; a persistently failing entry can therefore occupy admission capacity until it succeeds or an operator intervenes. Completed tombstones have no count cap so the full REST overlap window remains deduplicated even for busy inboxes; terminal failed tombstones remain capped at 450. The retention windows follow the WhatsApp precedent, while AgentMail's reject-new admission policy is plugin-owned and does not change WhatsApp's existing retention behavior. Live WebSocket admission is also process-bounded. When durable capacity is full, the live worker defers to the single REST catch-up supervisor rather than accumulating unbounded promises.

Unknown outbound sends are retried only while AgentMail's queue-derived idempotency key is safely inside the provider's 24-hour retention window. Immediately before the adapter starts provider I/O, core persists the final post-hook text and media request separately from the original replay payload. Recovery uses that immutable content with the same idempotency key, preventing hooks or media normalization from changing a retry. It also reconstructs the original agent-scoped local-media capability before reloading attachments. Once the key is within one hour of expiry, the delivery fails closed for operator review instead of risking a duplicate email.

## Why a new official plugin

The community `openclaw-agentmail` package was not suitable as the official implementation: it is WebSocket-only, treats an empty allowlist as open, replies to all recipients, has no durable SQLite ingress, and targets an older AgentMail/OpenClaw SDK generation. `openclaw-agentmail-listener` emits raw WebSocket system events and explicitly is not a channel. The official plugin therefore uses the current pinned AgentMail SDK and OpenClaw channel contracts instead of adopting either implementation.

The pinned AgentMail SDK documents `from` as either `sender@example.com` or `Display Name <sender@example.com>`. The plugin uses a small dependency-free, fail-closed parser for one mailbox. It also accepts the unambiguous `<sender@example.com>` form and common unquoted comma-containing display names. Lists, groups, address-shaped display names, control characters, quoted local parts, internationalized addresses, and malformed or ambiguous input are rejected instead of being authorized. All AgentMail-specific dependencies remain inside the separately published plugin.

## Troubleshooting

- `401`: the AgentMail webhook signing secret or forwarded raw body/headers do not match.
- `413`: the webhook body exceeds 1 MiB.
- `503`: the durable queue commit failed, so AgentMail should retry the webhook.
- No agent turn: verify the hydrated `From` mailbox appears in `allowFrom`; an empty list denies everyone.
- WebSocket did not start: remove `webhookSecret`; its presence always selects webhook mode. Check API access to both WebSockets and `messages.list`, because durable WebSocket recovery needs both.
- Outbound target rejected: use only the `message:<messageId>` target from the triggering inbound turn.

Run `openclaw channels status --probe` after changing configuration, then restart the Gateway because plugin metadata and ingress registration are process-stable.
