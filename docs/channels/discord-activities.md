---
summary: "Configure Discord Activities to launch the OpenClaw Canvas surface"
read_when:
  - Discord plugin setup is already working and you want Activities
  - You need exact Discord Developer Portal URL mapping values
title: "Discord Activities"
---

# Discord Activities

Status: ready for Activity-hosted Canvas (`/__openclaw__/canvas/`).

This page assumes your [Discord](/channels/discord) channel setup is already complete.

## Public HTTPS requirement

Discord Activities must load from a **public HTTPS URL**.

Not supported for Activity launch:

- `http://localhost:...`
- `http://192.168.x.x:...`
- `http://10.x.x.x:...`
- hostnames that are only reachable inside your home/LAN

Use an internet-reachable HTTPS host for your gateway.

Where this is documented elsewhere:

- [Tailscale (Serve and Funnel)](/gateway/tailscale)
- [Web bind and security modes](/web)
- [Google Chat public URL examples (Serve/Funnel + proxy patterns)](/channels/googlechat#public-url-webhook-only)

## Quick setup

<Steps>
  <Step title="Open your existing Discord app">
    Go to [Discord Developer Portal](https://discord.com/developers/applications) and open the same app you already use for OpenClaw Discord.
  </Step>

  <Step title="Enable Activities">
    Open **Activities > Settings** and turn on **Enable Activities**.

    Under **Supported Platforms**, enable the platforms you plan to test:

    - Web
    - Desktop
    - iOS
    - Android

  </Step>

  <Step title="Configure URL mappings">
    Open **Activities > URL Mappings** and add:

    | PREFIX | TARGET |
    | --- | --- |
    | `/` | `<your-gateway-host>/__openclaw__/canvas` |

    Example:

    | PREFIX | TARGET |
    | --- | --- |
    | `/` | `gateway.example.com/__openclaw__/canvas` |

    Rules:

    - TARGET must not include protocol.
      - Correct: `gateway.example.com/__openclaw__/canvas`
      - Wrong: `https://gateway.example.com/__openclaw__/canvas`
    - Keep `/` as the fallback mapping.
    - If you add more mappings, place longer prefixes before `/`.
    - Do not point `/` at gateway root alone, or Discord Activity launch will open the Control UI path instead of Canvas.

  </Step>

  <Step title="Enable Activity-scoped auth in OpenClaw (required)">
    Discord Activity iframes cannot send your normal Gateway bearer token.

    In your OpenClaw config, set:

```json5
{
  canvasHost: {
    activity: {
      enabled: true,
      // Optional shared token gate for activity requests.
      token: "<long-random-token>",
      // Optional override. Default is true; set false only for legacy/manual testing flows.
      requireLaunchContext: true,
    },
  },
}
```

    This keeps normal Gateway auth in place while allowing Activity-scoped Canvas access.

  </Step>

  <Step title="Set Activity launch URL">
    Use this Activity URL:

    - `https://<your-gateway-host>/`

    Discord launches at `/`, and URL mapping should rewrite that path to `/__openclaw__/canvas`.

    If `canvasHost.activity.token` is set, include `activityToken=<token>` in your mapped target or preserve it through your edge rewrite.

    Agents can still render A2UI experiences inside Canvas when needed.

  </Step>

  <Step title="Optional: add a launch button in Discord messages">
    Discord component buttons support:

    - `action: "launch-activity"`

    Example:

```json
{
  "label": "Open Activity",
  "style": "primary",
  "action": "launch-activity"
}
```

    Notes:

    - `launch-activity` works from guild channels.
    - It is not valid on link-style buttons.
    - In OpenClaw agent replies, prefer `message` tool helper `activityLaunchButton=true` for this action.

  </Step>

  <Step title="Optional: use OpenClaw Discord SDK helpers inside Canvas pages">
    Hosted Canvas pages auto-inject a Discord helper in Activity context:

    - `window.OpenClaw.discord` (alias: `window.openclawDiscord`)

    Common usage:

```js
await OpenClaw.discord.load();
await OpenClaw.discord.commands.openShareMomentDialog({ mediaUrl: "https://..." });
await OpenClaw.discord.commands.openExternalLink("https://docs.openclaw.ai");

const auth = await OpenClaw.discord.oauth.authorize({
  client_id: "<discord-app-id>",
  response_type: "code",
  scope: ["identify", "guilds"],
  prompt: "none",
  state: "example-state",
});
// exchange auth.code on your backend, then:
await OpenClaw.discord.oauth.authenticate({ access_token: "<app-access-token>" });
```

  </Step>

  <Step title="Verify before debugging client behavior">

```bash
curl -I "https://<your-gateway-host>/__openclaw__/canvas/"
```

    Expected:

    - HTTP `200`
    - `text/html` response

  </Step>
</Steps>

## Troubleshooting

### Activity does not appear in the shelf

- Confirm **Enable Activities** is on.
- Confirm current platform is enabled in **Supported Platforms**.
- Confirm app is installed in the context you are testing (guild/user install).

### Activity opens but shows 404 or blank page

- Confirm URL mapping is `PREFIX /` -> `TARGET <gateway-host>/__openclaw__/canvas`.
- Confirm TARGET has no protocol.
- Confirm gateway host is publicly reachable over HTTPS.
- Confirm you are not using an internal-only address.
- Confirm reverse proxy preserves `/__openclaw__/canvas/` path.

### Launch button says Activities are unavailable

- Confirm interaction came from a guild channel (not DM/group DM).
- Confirm Activities are enabled in the Developer Portal app.

### Activity opens but immediately fails auth

- Confirm `canvasHost.activity.enabled` is `true`.
- If `canvasHost.activity.token` is set, confirm the request carries `activityToken=<token>` and the token matches exactly.
- `canvasHost.activity.requireLaunchContext` is enabled by default; confirm launch context params (for example `instance_id`) are present on initial launch. Set it to `false` only if you intentionally allow direct/manual opens.

## Developer Portal quick links

- Applications: `https://discord.com/developers/applications`
- Activities settings: `https://discord.com/developers/applications/<app-id>/embedded/settings`
- Activities URL mappings: `https://discord.com/developers/applications/<app-id>/embedded/url-mappings`
- Installation: `https://discord.com/developers/applications/<app-id>/installation`

## Related

- [Discord](/channels/discord)
- [Chat Channels](/channels)
- [Nodes and Canvas A2UI](/nodes)
- [Tailscale](/gateway/tailscale)
- [Web](/web)
- Discord docs: [Activities Overview](https://docs.discord.com/developers/activities/overview)
