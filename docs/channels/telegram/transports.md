---
summary: "Long polling and webhook mode compared, with Gateway routes and durable ingress behavior"
read_when:
  - Choosing between long polling and webhook mode
  - Putting a reverse proxy in front of the Telegram Gateway webhook route
title: "Telegram transports"
sidebarTitle: "Transports"
---

Long polling is the default. Webhook mode is the alternative when an HTTPS ingress is available.

## Long polling and webhooks

<AccordionGroup>
  <Accordion title="Long polling vs webhook">
    Default is long polling. For webhook mode, set `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret`; optional `webhookPath` (default `/telegram-webhook`) and `webhookCertPath` (self-signed cert PEM for direct-IP or no-domain setups).

    The Gateway reserves `/health`, `/healthz`, `/ready`, `/readyz`, `/startup`, and `/startupz` for probes, including query variants. The `/api/channels` namespace also requires Gateway authentication, including encoded forms, and cannot receive direct Telegram callbacks. Choose `/telegram-webhook` or another route for Gateway ingress. The exact `/healthz` path remains reserved for the legacy listener's health check and cannot be a Telegram webhook path. Other Gateway-reserved paths can continue receiving callbacks through the legacy listener while you update `webhookPath`, `webhookUrl`, and the reverse proxy mapping; verify delivery before setting `legacyWebhook: false`. With legacy forwarding disabled, a reserved path produces an actionable startup error. Verify that [hot reload](/gateway/configuration/hot-reload) applied the route change with `openclaw channels status --probe`.

    In long-polling mode, OpenClaw saves its restart position after an update is committed to the durable ingress queue. A failed handler remains retryable from that queue.

    Webhook routes are available on the Gateway HTTP port (default `18789`). Point the reverse proxy for `webhookUrl` at that port and `webhookPath`. OpenClaw registers the configured public URL with Telegram on every webhook startup, including after a restart; it keeps that URL unchanged because it cannot infer an external proxy's upstream. Telegram's secret header remains the authentication boundary, so this route does not require a Gateway bearer token.

    Webhook mode keeps the previous forwarding endpoint at `127.0.0.1:8787` when `legacyWebhook` is omitted, so existing callbacks and reverse proxies continue working. Both ports use the same Gateway route handler and Telegram secret verification. To use only the Gateway port, move the reverse proxy upstream, verify incoming messages, then set `legacyWebhook: false`. Deleting the setting restores the default listener.

    The legacy port preserves its unauthenticated `/healthz` response (`200`, plain `ok`) and account-local failed-secret rate limit. Health matching is exact: query strings, trailing slashes, case changes, and encoded variants are not health checks. HEAD returns the same status without a body. The canonical Gateway port keeps its own probe and response-header behavior.

    After upgrading, run `openclaw doctor --fix`. Doctor backs up the config and migrates old `webhookPort` and `webhookHost` settings to `legacyWebhook: { port, host }`, preserving a host-only setting with port `8787`. An explicit endpoint object overrides the default; an omitted object host uses `127.0.0.1`. Existing `legacyWebhook: false` settings remain disabled during migration.

    Named accounts inherit the channel's `legacyWebhook` setting. An account-level `false` disables that account's legacy endpoint even when the channel config specifies an endpoint. An explicit account endpoint overrides an inherited `false`. A shared legacy socket stays open while another account still uses that endpoint.

    Accounts may share a Gateway route when their webhook secrets differ. Requests matching more than one account are rejected; assign distinct secrets or paths before moving traffic to the Gateway port. Migrated legacy endpoints preserve account selection for accounts that previously shared a secret and path on separate explicit ports.

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
