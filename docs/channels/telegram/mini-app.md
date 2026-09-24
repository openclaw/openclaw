---
summary: "Open the OpenClaw Control UI as a Telegram WebApp with /dashboard"
read_when:
  - Opening the OpenClaw dashboard from inside Telegram
  - Publishing the gateway over Tailscale serve or funnel
title: "Telegram Dashboard Mini App"
sidebarTitle: "Dashboard Mini App"
---

Run the Control UI inside Telegram as a Mini App.

## Dashboard Mini App

The Dashboard Mini App opens the full [OpenClaw Control UI](/web/control-ui) as a Telegram WebApp. Run `/dashboard` in a DM with the bot, then tap **Open dashboard**. The command is registered automatically when the Telegram plugin is active; there is no separate Mini App flag.

Requirements:

- `gateway.tailscale.mode: "serve"` or `"funnel"` for the published HTTPS Mini App URL.
- Your numeric Telegram user ID must be in the selected account's effective `allowFrom` or in `commands.ownerAllowFrom`. Wildcards and usernames do not grant Mini App owner access.
- Use a DM. In groups, `/dashboard` replies with `open this in a DM with the bot` and sends no button.
- Docker installs: Serve/Funnel modes require the gateway to bind loopback next to `tailscaled`, which bridge networking with published ports cannot satisfy. Run the gateway container with `network_mode: host` and mount the host `tailscaled` socket (`/var/run/tailscale`) plus the `tailscale` CLI into the container.

Configure one of the supported Tailscale publishing modes:

```json5
{
  gateway: {
    tailscale: {
      mode: "serve", // or "funnel"
    },
  },
}
```

OpenClaw automatically honors `gateway.controlUi.basePath` when building the Control UI and WebSocket URLs.

When the Mini App opens, Telegram provides signed WebApp `initData`. OpenClaw verifies its signature with the selected bot account's token, rejects missing, invalid, expired, or replayed data, extracts the numeric Telegram user ID, and checks owner access again before handing off to the Control UI.

If `/dashboard` cannot resolve a published HTTPS URL, it replies with:

```text
Mini App needs an HTTPS gateway URL. Set `gateway.tailscale.mode: serve` or `funnel`, then retry.
```

Set one of the modes shown above, make sure Tailscale is running on the gateway host, and retry the command.

The Mini App is a Tailscale-only v1 path and does not support Telegram Web iframe.
