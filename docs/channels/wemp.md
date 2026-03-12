---
summary: "WeChat Official Account (wemp) plugin setup, config, and operations"
read_when:
  - You want to connect OpenClaw to a WeChat Official Account
  - You need webhook verification and secure message handling
title: WeChat Official Account
---

# WeChat Official Account (plugin)

`wemp` connects OpenClaw to WeChat Official Account (微信公众号) via webhook callbacks and customer service messaging APIs.

Status: plugin channel. Direct messages, pairing-based access control, account routing, and basic media relay are supported.

## Plugin required

```bash
openclaw plugins install @openclaw/wemp
```

Local checkout:

```bash
openclaw plugins install ./extensions/wemp
```

## Setup

1. Prepare your WeChat Official Account credentials:
   - `appId`
   - `appSecret`
   - `token`
   - Optional `encodingAESKey` (for encrypted mode)
2. Configure a webhook path (example: `/wemp`).
3. Expose your gateway over HTTPS and set callback URL in WeChat:

```text
https://gateway-host/wemp
```

If you use account-specific paths, set `channels.wemp.accounts.<id>.webhookPath` and match it in WeChat.

## Configure

Minimal config:

```json5
{
  channels: {
    wemp: {
      enabled: true,
      appId: "wx_your_app_id",
      appSecret: "YOUR_APP_SECRET_HERE",
      token: "YOUR_TOKEN_HERE",
      webhookPath: "/wemp",
      dm: {
        policy: "pairing",
      },
      routing: {
        pairedAgent: "main",
        unpairedAgent: "wemp-kf",
      },
    },
  },
}
```

Common policies:

- `channels.wemp.dm.policy`: `pairing | allowlist | open | disabled`
- `channels.wemp.dm.allowFrom`: explicit allowlist entries
- `channels.wemp.requireHttps`: require HTTPS for webhook requests

## Feature flags

`wemp` supports optional feature flags under `channels.wemp.features`:

- `menu`: WeChat custom menu sync (`click` and `view` items)
- `handoff`: manual handoff mode, resume, and optional webhook notifications
- `assistantToggle`: per-user assistant on/off state
- `usageLimit`: daily message/token limit controls
- `routeGuard`: restrict unpaired traffic to allowed agents
- `welcome`: subscribe welcome text

Example:

```json5
{
  channels: {
    wemp: {
      enabled: true,
      appId: "wx_your_app_id",
      appSecret: "YOUR_APP_SECRET_HERE",
      token: "YOUR_TOKEN_HERE",
      webhookPath: "/wemp",
      dm: { policy: "pairing" },
      routing: {
        pairedAgent: "main",
        unpairedAgent: "wemp-kf",
      },
      features: {
        menu: {
          enabled: true,
          items: [
            { name: "AI Help", type: "click", key: "menu_ai_help" },
            { name: "Website", type: "view", url: "https://example.com" },
          ],
        },
        assistantToggle: {
          enabled: true,
          defaultEnabled: true,
        },
        usageLimit: {
          enabled: true,
          dailyMessages: 30,
          dailyTokens: 8000,
          exemptPaired: true,
        },
        routeGuard: {
          enabled: true,
          unpairedAllowedAgents: ["wemp-kf"],
        },
        handoff: {
          enabled: true,
          contact: "Support Team",
          message: "For manual support, contact: {{contact}}",
          autoResumeMinutes: 30,
          activeReply: 'Manual handoff is active. Send "恢复AI" to resume.',
          ticketWebhook: {
            enabled: true,
            endpoint: "https://gateway-host/wemp/handoff-ticket",
            token: "YOUR_TOKEN_HERE",
            events: ["activated", "resumed"],
          },
        },
        welcome: {
          enabled: true,
          subscribeText: "Welcome. AI assistant is now available.",
        },
      },
    },
  },
}
```

## Media support boundary

Current behavior is intentionally scoped:

- Inbound:
  - Text and event messages are supported
  - Image and voice messages can be normalized into message summaries
  - Voice transcription is optional through a custom HTTP endpoint
- Outbound:
  - Text sending is supported
  - Generic `sendMedia` flow currently uploads and sends image payloads
  - Voice/video/file APIs exist in the plugin internals but are not fully exposed as a unified outbound contract yet

If your workflow depends on non-image outbound media as a first-class channel capability, treat it as partial support and validate in your deployment before production rollout.

## Pairing

When DM policy is `pairing`, unknown users receive a pairing code and cannot access protected routes until approved.

```bash
openclaw pairing list wemp
openclaw pairing approve wemp <CODE>
```

Pairing notes:

- Keep CLI and gateway processes on the same state directory/profile when approving codes.
- If pending requests are not visible in `openclaw pairing list wemp`, verify runtime/state alignment first.
- For deterministic rollout in restricted environments, prefer `allowlist` with explicit `channels.wemp.dm.allowFrom` entries.

## Key environment variables

Operationally useful overrides:

- HTTPS and proxy:
  - `WEMP_REQUIRE_HTTPS`
  - `WEMP_WEBHOOK_TRUST_PROXY`
- Webhook hardening:
  - `WEMP_WEBHOOK_TIMESTAMP_WINDOW_SEC`
  - `WEMP_WEBHOOK_REPLAY_WINDOW_SEC`
  - `WEMP_WEBHOOK_REPLAY_CACHE_MAX`
  - `WEMP_WEBHOOK_MAX_BODY_BYTES`
  - `WEMP_WEBHOOK_BODY_READ_TIMEOUT_MS`
- Inbound request limits:
  - `WEMP_RATE_LIMIT_WINDOW_MS`
  - `WEMP_RATE_LIMIT_MAX`
- Outbound retry:
  - `WEMP_OUTBOUND_RETRIES`
  - `WEMP_OUTBOUND_RETRY_DELAY_MS`
- Voice transcription:
  - `WEMP_VOICE_TRANSCRIBE_ENDPOINT`
  - `VOICE_TRANSCRIBE_ENDPOINT`
  - `WEMP_VOICE_TRANSCRIBE_TIMEOUT_MS`
- Pairing notification webhook:
  - `WEMP_PAIRING_NOTIFY_ENDPOINT`
  - `WEMP_PAIRING_NOTIFY_TOKEN`
  - `WEMP_PAIRING_NOTIFY_TIMEOUT_MS`
  - `WEMP_PAIRING_NOTIFY_RETRIES`
- Handoff notification webhook:
  - `WEMP_HANDOFF_NOTIFY_ENDPOINT`
  - `WEMP_HANDOFF_NOTIFY_TOKEN`
  - `WEMP_HANDOFF_NOTIFY_TIMEOUT_MS`
  - `WEMP_HANDOFF_NOTIFY_RETRIES`
  - `WEMP_HANDOFF_TICKET_ENDPOINT`
  - `WEMP_HANDOFF_TICKET_TOKEN`
  - `WEMP_HANDOFF_TICKET_EVENTS`

## Troubleshooting

- Webhook verification fails:
  - Check `token`, `webhookPath`, and callback URL.
  - Ensure proxy forwards HTTPS headers correctly when `requireHttps` is enabled.
- Inbound requests rejected:
  - Validate timestamp/signature parameters and clock skew.
- Outbound send failures:
  - Check WeChat API error code/rate limit and credential validity.
