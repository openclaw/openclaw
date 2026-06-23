---
summary: "Cross-platform iMessage via Photon Spectrum"
read_when:
  - You want iMessage without a local macOS imsg bridge
  - You are setting up Photon Spectrum credentials and webhooks
title: "iMessage (Spectrum)"
---

**Status:** bundled plugin. Cloud iMessage through [Photon Spectrum](https://spectrum.photon.codes) for Mac, Linux, Windows, WSL, servers, and containers.

Use this channel when the Gateway cannot run `imsg` on a signed-in Messages Mac. For native macOS integration, see [iMessage](/channels/imessage).

## Quick setup

1. Add the channel:

```bash
openclaw channels add imessage-spectrum
```

Or non-interactively:

```bash
openclaw channels add imessage-spectrum \
  --project-id "photon_project_id" \
  --project-secret "photon_project_secret" \
  --webhook-base-url "https://your-gateway.example.com"
```

2. Expose the gateway with a public HTTPS URL (for example Cloudflare Tunnel):

```bash
cloudflared tunnel --url http://localhost:18789
openclaw config set channels.imessage-spectrum.webhookBaseUrl https://your-tunnel-url.example.com
```

3. Register the webhook:

```bash
openclaw channels add imessage-spectrum --register-webhook
```

4. Restart and verify:

```bash
openclaw gateway restart
curl https://your-tunnel-url.example.com/channels/imessage-spectrum/health
```

## Configuration reference

| Key              | Required    | Description                                                   |
| ---------------- | ----------- | ------------------------------------------------------------- |
| `projectId`      | Yes         | Spectrum project ID                                           |
| `projectSecret`  | Yes         | Spectrum project secret                                       |
| `webhookSecret`  | For inbound | Photon webhook signing secret                                 |
| `webhookBaseUrl` | For inbound | Public HTTPS base URL of the gateway                          |
| `enabled`        |             | Enable or disable the channel                                 |
| `dmPolicy`       |             | DM access policy (`pairing`, `allowlist`, `open`, `disabled`) |
| `allowFrom`      |             | Allowed sender handles                                        |

## Message effects

Prefix outbound text with `!!effect_name` or set `effectName` on a `message` tool send:

`slam`, `loud`, `gentle`, `invisible`, `confetti`, `fireworks`, `balloons`, `heart`, `lasers`, `celebration`, `sparkles`, `spotlight`, `echo`.

## Diagnostics

```bash
openclaw doctor imessage-spectrum
curl <public-base-url>/channels/imessage-spectrum/health
```

## Architecture

```
iMessage App <-> Photon Cloud <-> Spectrum SDK <-> OpenClaw Gateway
                         |
                  Webhook (HTTPS POST)
```
