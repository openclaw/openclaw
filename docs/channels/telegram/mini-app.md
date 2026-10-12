---
summary: "Open the OpenClaw Control UI as a Telegram WebApp with /controlui"
read_when:
  - Opening the OpenClaw Control UI from inside Telegram
  - Publishing the gateway over Tailscale serve or funnel
  - Publishing the gateway through a reverse proxy or tunnel with gateway.publicOrigin
title: "Telegram Control UI Mini App"
sidebarTitle: "Control UI Mini App"
---

Run the Control UI inside Telegram as a Mini App.

<a id="dashboard-mini-app" />

## Control UI Mini App

The Control UI Mini App opens the full [OpenClaw Control UI](/web/control-ui) as a Telegram WebApp. Run `/controlui` in a DM with the bot, then tap **Open Control UI**. The command is registered automatically when the Telegram plugin is active; there is no separate Mini App flag.

`/dashboard` creates or updates a session dashboard on Telegram, as it does on other channels. Use `/controlui` to open OpenClaw’s Control UI.

Requirements:

- A published HTTPS Mini App URL: an https `gateway.publicOrigin`, or `gateway.tailscale.mode: "serve"` or `"funnel"`.
- Your numeric Telegram user ID must be in the selected account's effective `allowFrom` or in `commands.ownerAllowFrom`. Wildcards and usernames do not grant Mini App owner access.
- Use a DM. In groups, `/controlui` replies with `open this in a DM with the bot` and sends no button.
- Docker installs: Serve/Funnel modes require the gateway to bind loopback next to `tailscaled`, which bridge networking with published ports cannot satisfy. Run the gateway container with `network_mode: host` and mount the host `tailscaled` socket (`/var/run/tailscale`) plus the `tailscale` CLI into the container.

If `/controlui` replies with `Restricted to the bot owner`, ask your OpenClaw administrator to add the numeric Telegram user ID shown in the reply to the selected bot account's `allowFrom` (for example, `channels.telegram.accounts.ops.allowFrom`) or to `commands.ownerAllowFrom` using a `telegram:<userId>` entry. Keep existing allowlist entries and retry `/controlui` after the configuration change takes effect. The administrator can also add the numeric ID to the Telegram members of an access group already referenced by that owner list.

<a id="upgrading-from-dashboard" />

## Upgrading from `/dashboard`

Earlier releases, including OpenClaw 2026.8.x and 2026.9.1, used `/dashboard` to open the Telegram Mini App. Use `/controlui` after upgrading, and update saved instructions, shortcuts, and custom bot-menu descriptions that referred to the Mini App. `/dashboard` now creates or updates a session dashboard; it does not redirect to `/controlui`.

The Gateway registers the new command in the bot menu when the Telegram account starts. The Mini App URL and Tailscale configuration stay the same. Request a fresh `/controlui` button; previous launch links are short-lived.

After an upgrade, wildcard-only access groups no longer grant Control UI launch or Mini App authentication. Add an explicit numeric owner ID to restore access; usernames and wildcards remain insufficient.

## Publish the Mini App

OpenClaw builds the Mini App URL from the first source that resolves:

1. `gateway.publicOrigin`, when it is an absolute `https:` origin without a path, query, or hash, and the Control UI origin policy admits it (see below).
2. Tailscale Serve or Funnel.

When both are configured (mixed ingress), the public origin wins only if the Control UI would accept a browser from it: `gateway.controlUi.allowedOrigins` is unset, or lists that origin or `"*"`. If an explicit `allowedOrigins` list leaves it out, the Mini App keeps the Tailscale URL, so an existing tailnet-only allowlist keeps working after you add `gateway.publicOrigin`.

### Reverse proxy or tunnel

If an HTTPS reverse proxy or tunnel already publishes the gateway, set its origin as `gateway.publicOrigin`. Tailscale is not required:

```json5
{
  gateway: {
    publicOrigin: "https://gateway.example.com",
    trustedProxies: ["127.0.0.1"], // address the proxy connects from
  },
}
```

The Control UI accepts `gateway.publicOrigin` automatically while `gateway.controlUi.allowedOrigins` is unset. If you set `gateway.controlUi.allowedOrigins` explicitly, include the same origin there. Add the proxy address to `gateway.trustedProxies`. An `http:` origin, or an origin with a path, is ignored for the Mini App because Telegram only opens HTTPS WebApp URLs; OpenClaw then falls back to Tailscale.

### Tailscale

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

If `/controlui` cannot resolve a published HTTPS URL, it replies with:

```text
Mini App needs an HTTPS gateway URL. Set an https `gateway.publicOrigin`, or set `gateway.tailscale.mode: serve` or `funnel`, then retry /controlui.
```

Set an https `gateway.publicOrigin`, or set one of the Tailscale modes shown above and make sure Tailscale is running on the gateway host, then retry the command.

If an https `gateway.publicOrigin` is set but excluded by an explicit `gateway.controlUi.allowedOrigins` list and Tailscale is not available, the reply names the origin to add to `gateway.controlUi.allowedOrigins`.

The Mini App does not support Telegram Web iframe.
