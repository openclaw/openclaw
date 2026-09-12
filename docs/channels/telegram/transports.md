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

    The listener reserves `/healthz` for health checks, so `webhookPath` must use a different route. If an existing setup uses `/healthz`, choose another route, update the path in `webhookUrl` and the reverse proxy mapping, then restart OpenClaw.

    In long-polling mode, OpenClaw saves its restart position after an update is committed to the durable ingress queue. A failed handler remains retryable from that queue.

    The local listener binds to `127.0.0.1:8787` by default. For public ingress, put a reverse proxy in front of the local port, or set `webhookHost: "0.0.0.0"` intentionally.

    Webhook mode validates request guards, the Telegram secret token, and the JSON body, then commits the update to its durable ingress queue before returning an empty `200`. Successful durable adoption includes `x-openclaw-delivery-accepted: durable`; health, routing, authentication, validation, and storage-error responses omit this header. Reverse proxies and host controllers can require the header to distinguish OpenClaw adoption from a generic empty `200` without inferring acceptance from response timing.

    After the durable write, OpenClaw claims and processes updates through the core channel-ingress drain (per-chat/per-topic lanes, complete at turn adoption, pre-adoption stall timeout). Slow agent turns do not hold Telegram's delivery ACK.

  </Accordion>
</AccordionGroup>
