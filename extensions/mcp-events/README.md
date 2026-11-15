# MCP Events

Optional bundled source for event-driven OpenClaw automations. This implements
OpenAI's versioned MCP Events webhook profile for MCP 2.0 (protocol version
2026-07-28), not the experimental polling, streaming, gap, or terminated controls.

## Setup

1. Configure and authenticate an HTTP MCP server through OpenClaw's existing MCP
   connection settings. This plugin does not store a second set of credentials.
2. Enable `mcp-events` and configure `callbackOrigin` with a public HTTPS origin.
   Forward only `/plugins/mcp-events/callback/*` through your reverse proxy. Do not
   expose the Gateway administration surface. OpenClaw neither creates a tunnel
   nor changes network exposure for you. DNS/public-address preflight does not
   prove reachability; the server's signed challenge does.
3. Create an automation with an authored agent-turn instruction and this schedule:

```json
{
  "kind": "event",
  "source": "mcp-events",
  "options": {
    "server": "configured-server",
    "name": "comment.created",
    "arguments": { "document_id": "doc-123" }
  }
}
```

The connected server must advertise `capabilities.events` from `server/discover`
and support `events/list`, `events/subscribe`, and `events/unsubscribe` on the
same native authenticated endpoint. Schemas and filters come from that account's
catalog. Subscription identity includes its principal, callback URL, event name,
and canonical JSON arguments.

## Delivery and lifecycle

- Every binding has a distinct 32-byte signing key. Pending callback facts are
  stored in plugin-scoped SQLite before subscribing, so verification can arrive
  before the subscribe response. The callback validates Standard Webhooks HMAC
  over the exact bytes, with a five-minute signing-clock window. The unsigned
  subscription-id header never grants authority.
- Each request contains one JSON event no larger than 256 KiB. Its event ID,
  name, timestamp, and payload schema must validate. Only verification controls
  are accepted. A `2xx` means durable ingress receipt/deduplication, not completed
  automation execution. Capacity or storage failures return retryable responses;
  unfinished queue rows are never evicted to make room.
- The existing shared ingress drain hands claims to the existing Cron execution
  owner. That owner atomically transfers the claim into its run receipt. Event
  data remains untrusted input, separate from authored instructions. It cannot
  select a session, agent, tools, credentials, or privileges.
- The existing Gateway scheduler owns refresh, backoff, reconciliation, and drain
  deadlines; there are no model-driven maintenance jobs or new global scheduler.
  Finite expiry, last durably received cursor, pending rotation, and truncated
  history survive restart. Refresh replaces the signing key with a short overlap.
- Pause, removal, source replacement, and account revocation stop local acceptance
  before remote unsubscribe. A stale refresh reply cannot revive the binding.
  Enabled sources retry automatically after credential replacement or reconnect,
  using a new binding and signing key; old callbacks and queued claims stay invalid.
  When the original account is unavailable after restart, remote cleanup can be
  blocked until the server's finite expiry; diagnostics retain that condition.
- A null cursor means the source cannot replay missed events. A truncated flag
  means the server reports missing history. Upstream retries can be abandoned
  before a newer watermark, and deliveries can be out of order. This is not an
  end-to-end lossless or exactly-once promise. Make downstream writes idempotent.

Subscription diagnostics expose status, finite expiry, retry state, replay
availability, truncation, and cleanup status—not callback secrets, arguments,
raw event data, or MCP credentials. Local binding facts are bounded at 4096
records with reject-new retention. Queues reject new work at `maxPendingEvents`
(default 10000 per native account), retaining existing pending/claimed work.

Protocol reference: <https://developers.openai.com/plugins/build/mcp-events>.
