---
summary: "Feishu/Lark bot setup wizard, and how inbound events are durably queued"
read_when:
  - Connecting a Feishu or Lark bot for the first time
  - Choosing between WebSocket and webhook event delivery
title: "Feishu setup"
sidebarTitle: "Setup"
---

Run the channel setup wizard, then understand how OpenClaw durably accepts inbound Feishu events.

## Quick start

<Note>
Requires OpenClaw 2026.5.29 or above. Run `openclaw --version` to check. Upgrade with `openclaw update`.
</Note>

<Steps>
  <Step title="Run the channel setup wizard">
  ```bash
  openclaw channels login --channel feishu
  ```
  This installs the `@openclaw/feishu` plugin if it is missing, then walks through setup:

- **Manual setup**: paste an App ID and App Secret from Feishu Open Platform (`https://open.feishu.cn`) or Lark Developer (`https://open.larksuite.com`).
- **QR setup**: scan a QR code in the Feishu app to create a bot automatically. This flow locks DMs to your own account (`dmPolicy: "allowlist"` with your `open_id`).

The wizard also asks for the API domain (Feishu vs Lark) and the group policy. If the domestic Feishu mobile app does not react to the QR code, rerun setup and choose manual setup.
</Step>

  <Step title="Verify the channel after setup">
  <a id="after-setup-completes%2C-restart-the-gateway-to-apply-the-changes" />
  Config changes follow [hot reload](/gateway/configuration/hot-reload). Check that Feishu is ready:
  ```bash
  openclaw channels status --probe
  ```
  Start the Gateway if it is offline.
  </Step>
</Steps>

## Inbound durability

OpenClaw durably queues authenticated `im.message.receive_v1` and `drive.notice.comment_add_v1` envelopes before agent dispatch. In webhook mode, the durable `200` carries `x-openclaw-delivery-accepted: durable`; verification challenges, non-durable event types, and error responses omit the marker, so reverse proxies can require it to distinguish durable acceptance from a generic `200`. Pending or retryable events survive a Gateway restart, remain serialized per chat or document, and use Feishu's event ID to suppress duplicate queue entries while the active or retained completion record exists.

If a WebSocket event cannot be persisted after bounded retries, OpenClaw closes that socket and forces a fresh authenticated connection instead of continuing past an uncommitted turn. Other Feishu event types, including reactions and VC meeting invitations, use their normal event paths and do not receive this durable-queue guarantee.

## Webhook delivery window

Feishu signs each webhook delivery at send time, so a captured signed callback stays validly signed forever. Webhook mode therefore rejects any signed callback whose `x-lark-request-timestamp` is more than one hour before or after the Gateway host's clock, before the body is parsed. This is a replay defense: it works together with the per-message replay guard (24-hour window) so a re-delivered signed callback cannot re-trigger the same action.

Practical consequences:

- Keep the Gateway host clock synchronized (NTP). A host clock drifting more than one hour from Feishu's servers rejects fresh deliveries.
- Feishu deliveries are signed when they are sent, so ordinary redeliveries carry fresh timestamps and are unaffected.
- WebSocket mode is not affected by this window.
- There is no configuration key for this window; it is intentionally fixed.
