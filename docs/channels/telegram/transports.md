---
summary: "Long polling and webhook mode compared, with listener and durable ingress behavior"
read_when:
  - Choosing between long polling and webhook mode
  - Putting a reverse proxy in front of the Telegram webhook listener
title: "Telegram transports"
sidebarTitle: "Transports"
---

Long polling is the default. Webhook mode is the alternative when an HTTPS ingress is available.

## Long polling and webhooks

<AccordionGroup>
  <Accordion title="Long polling vs webhook">
    Default is long polling. For webhook mode, set `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret`; optional `webhookPath` (default `/telegram-webhook`), `webhookHost` (default `127.0.0.1`), `webhookPort` (default `8787`), `webhookCertPath` (self-signed cert PEM for direct-IP or no-domain setups).

    The listener reserves `/healthz` for health checks, so `webhookPath` must use a different route. If an existing setup uses `/healthz`, choose another route, update the path in `webhookUrl` and the reverse proxy mapping, then verify that [hot reload](/gateway/configuration/hot-reload) applied the listener change with `openclaw channels status --probe`.

    In long-polling mode, OpenClaw saves its restart position after an update is committed to the durable ingress queue. A failed handler remains retryable from that queue.

    The local listener binds to `127.0.0.1:8787` by default. For public ingress, put a reverse proxy in front of the local port, or set `webhookHost: "0.0.0.0"` intentionally.

    Webhook mode validates request guards, the Telegram secret token, and the JSON body, then commits the update to its durable ingress queue before returning an empty `200`. Successful durable adoption includes `x-openclaw-delivery-accepted: durable`; health, routing, authentication, validation, and storage-error responses omit this header. Reverse proxies and host controllers can require the header to distinguish OpenClaw adoption from a generic empty `200` without inferring acceptance from response timing.

    After the durable write, OpenClaw claims and processes updates through the core channel-ingress drain (per-chat/per-topic lanes, complete at turn adoption, pre-adoption stall timeout). Slow agent turns do not hold Telegram's delivery ACK.

  </Accordion>
</AccordionGroup>

## Ingress acknowledgment boundary

Telegram acknowledgment is gated by durable queue admission, not by plugin
hooks or completion of an agent turn. Webhook mode uses the boundary described
above; long polling uses this sequence:

1. The polling worker receives one Telegram update and waits.
2. OpenClaw transactionally enqueues the raw update in the account-scoped
   `channel_ingress_events` queue in `state/openclaw.sqlite`.
3. After enqueue succeeds, OpenClaw schedules persistence of the restart offset
   and acknowledges the worker, allowing polling to continue.
4. The shared drain processes the queued update separately. If admission fails,
   OpenClaw rejects the worker acknowledgment instead of silently advancing.

`offset queued` means the restart-offset write was scheduled, not committed. A
crash before that write finishes can make Telegram redeliver an update that is
already queued. The queue rejects the same transport event ID only while its
pending row, completed tombstone, or failed row remains. This is bounded replay
deduplication, not exactly-once processing. See
[durable ingress and replay dedupe](/plugins/sdk-channel-plugins/durable-ingress#durable-ingress-and-replay-dedupe).

### Replay limits

For each Telegram account queue, completed tombstones and failed rows are
retained for up to 30 days and capped at 1,000 entries per class. Whichever
limit is reached first ends retention for that class. Completion scrubs the
inbound payload and metadata while retaining the event identity.

A crash after a side effect but before queue completion can repeat that side
effect. See [transport retention](/plugins/sdk-channel-plugins/durable-ingress#transport-classes-and-retention),
[at-least-once side effects](/plugins/sdk-channel-plugins/durable-ingress#at-least-once-side-effects),
and [inbound dead letters](/cli/channels#inbound-dead-letters).

The documented durability boundary is successful completion of the SQLite
transaction, not a separate per-event fsync guarantee. Use a persistent state
directory; deleting it loses both queued updates and the saved polling offset.

### Shutdown

Long polling and webhook accounts wait for already-admitted replay commits or
rollbacks even after their 15-second ingress shutdown grace expires. Accepted
group introductions remain tracked through their existing 60-second agent-turn
budget and the following dedupe commit before account shutdown completes.
Cancellation before an introduction is accepted prevents it from starting.
Ordinary handler and bot shutdown grace periods remain unchanged.

### Plugin hooks

No plugin hook can defer Telegram's transport acknowledgment until plugin-owned
persistence completes:

- `message_received` is a fire-and-forget observation of an accepted inbound turn.
- `before_dispatch` is a conditional claim before normal model dispatch.
- `before_agent_run` is a gate immediately before model submission and runs only
  when a model turn reaches that stage.

None receives the raw update as a persistence boundary. See
[message and delivery hooks](/plugins/hooks/messages) and the
[hook catalog](/plugins/hooks/reference#hook-catalog).
