---
summary: "AgentMail email channel setup, verified ingress, sender allowlisting, threading, and attachments"
read_when:
  - You want OpenClaw to receive and reply to email through AgentMail
  - You need webhook or WebSocket AgentMail setup
title: "AgentMail"
---

AgentMail connects one OpenClaw channel account to one AgentMail inbox. Incoming email is durably queued, hydrated from AgentMail's REST API, checked against a sender allowlist, and dispatched as a threaded agent turn. Replies are always bound to the incoming message; the plugin cannot start a thread or choose recipients.

Status: official plugin, installed separately. Requires OpenClaw `2026.7.2` or newer.

## Install

```bash
openclaw plugins install @openclaw/agentmail
```

## Configure webhook ingress

Create an AgentMail inbox and a `message.received` webhook subscription whose URL reaches the exact Gateway path. OpenClaw does not create or manage production AgentMail webhooks.

```yaml
channels:
  agentmail:
    enabled: true
    defaultAccount: default
    accounts:
      default:
        apiKey: { source: env, provider: default, id: AGENTMAIL_API_KEY }
        inboxId: inbox_...
        webhookSecret: { source: env, provider: default, id: AGENTMAIL_WEBHOOK_SECRET }
        webhookPath: /webhooks/agentmail
        dmPolicy: allowlist
        allowFrom:
          - sender@example.com
        mediaMaxMb: 20
```

Configure the AgentMail webhook as:

```text
POST https://gateway.example.com/webhooks/agentmail
event type: message.received
```

The plugin verifies the Svix signature over the untouched request body before parsing it. It accepts at most 1 MiB of webhook data and acknowledges only after the shared SQLite ingress queue commits the event. Expose only the configured webhook path through your reverse proxy.

For named accounts, the default path is `/webhooks/agentmail/<accountId>`. Set an explicit `webhookPath` when your public routing requires a different path. Paths must be unique across accounts.

## WebSocket alternative

Omit `webhookSecret` to use AgentMail WebSocket ingress:

```yaml
channels:
  agentmail:
    apiKey: { source: env, provider: default, id: AGENTMAIL_API_KEY }
    inboxId: inbox_...
    dmPolicy: allowlist
    allowFrom: [sender@example.com]
```

Webhook and WebSocket are configuration alternatives. The plugin does not switch to WebSocket because a configured webhook has been quiet or unreachable. WebSocket reconnects re-subscribe to the configured inbox and `message.received` event.

## Sender security

`dmPolicy` defaults to `allowlist`. Missing or empty `allowFrom` denies every sender. Entries are exact mailbox addresses, normalized case-insensitively after authoritative REST hydration and single-mailbox parsing.

To intentionally accept every sender, configure both values explicitly:

```yaml
dmPolicy: open
allowFrom: ["*"]
```

Every message is authorized independently, even when several people participate in the same AgentMail thread. Ambiguous or missing `From` mailboxes are rejected without starting an agent turn.

## Reply-only delivery and threads

The only outbound target is:

```text
message:<messageId>
```

The triggering message ID is fixed for the whole turn. The outbound adapter accepts only the implicit source-message binding supplied by the active inbound turn; proactive sends, explicit reply overrides, and attempts to switch to another message ID are rejected. OpenClaw does not keep a thread-to-latest-message pointer. Each reply calls AgentMail with `replyAll: false`, omits all recipient overrides, and uses an idempotency key derived from OpenClaw's durable delivery queue record. A multi-recipient email therefore receives a reply only through AgentMail's sender-reply semantics.

Sessions are keyed by OpenClaw account, AgentMail inbox, and AgentMail thread ID. Participants share the thread context, while sender authorization remains per message.

## Message bodies and attachments

The REST-hydrated plain-text body is preferred. HTML-only mail is converted through OpenClaw's shared HTML-to-text helpers. When no body is available, the hydrated subject becomes the message. Transport event bodies are never used as authoritative content.

Inbound attachment metadata is hydrated with AgentMail's positional API, and its short-lived `downloadUrl` is loaded through OpenClaw's bounded, SSRF-aware media path. Inline/CID parts are skipped. Per-file and aggregate limits use `mediaMaxMb` (default 20 MiB). All accepted attachments must download before the agent turn starts; a transient download failure dispatches nothing and leaves the durable event retryable. A deterministic size-policy rejection omits the complete attachment set, adds an omission notice, and still dispatches the authoritative body or subject.

Outbound text and attachments are normalized and loaded before one AgentMail reply request. Replies are not streamed or split into separate email messages.

## Durability

Webhook and WebSocket events share a digest of account ID, inbox ID, and message ID, so retries, reconnects, and transport changes deduplicate to one turn. OpenClaw persists restart-recovery delivery state before agent or tool execution, and the plugin durably adopts the turn by completing its ingress row at that boundary. A fresh turn does not start if completion fails. If an active turn was already irrevocably queued, ingress retries only the completion marker and never redispatches it. After successful adoption, core recovery owns interrupted delivery. Pending and failed ingress records are retained for 30 days; completed records for 7 days; each journal state is capped at 450 records. These values follow the WhatsApp durable-receive precedent.

## Why a new official plugin

The community `openclaw-agentmail` package was not suitable as the official implementation: it is WebSocket-only, treats an empty allowlist as open, replies to all recipients, has no durable SQLite ingress, and targets an older AgentMail/OpenClaw SDK generation. `openclaw-agentmail-listener` emits raw WebSocket system events and explicitly is not a channel. The official plugin therefore uses the current pinned AgentMail SDK and OpenClaw channel contracts instead of adopting either implementation.

The pinned AgentMail SDK documents `from` as either `sender@example.com` or `Display Name <sender@example.com>`. The plugin uses a small dependency-free, fail-closed parser for one mailbox. It also accepts the unambiguous `<sender@example.com>` form and common unquoted comma-containing display names. Lists, groups, address-shaped display names, control characters, quoted local parts, internationalized addresses, and malformed or ambiguous input are rejected instead of being authorized. All AgentMail-specific dependencies remain inside the separately published plugin.

## Troubleshooting

- `401`: the AgentMail webhook signing secret or forwarded raw body/headers do not match.
- `413`: the webhook body exceeds 1 MiB.
- `503`: the durable queue commit failed, so AgentMail should retry the webhook.
- No agent turn: verify the hydrated `From` mailbox appears in `allowFrom`; an empty list denies everyone.
- WebSocket did not start: remove `webhookSecret`; its presence always selects webhook mode.
- Outbound target rejected: use only the `message:<messageId>` target from the triggering inbound turn.

Run `openclaw channels status --probe` after changing configuration, then restart the Gateway because plugin metadata and ingress registration are process-stable.
