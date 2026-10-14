---
summary: "Deploy OpenClaw on Pethost with one-click template"
read_when:
  - Deploying OpenClaw to Pethost
  - You want a one-click cloud deploy with browser-based Control UI
title: "Pethost"
---

Deploy OpenClaw on [Pethost](https://pethost.dev) with a one-click template and access it through the web Control UI. The template runs the Gateway from the official Docker image as a Docker Compose project, served over HTTPS.

## How to get started

1. Open the [OpenClaw template](https://pethost.dev/templates/openclaw/) and click **Deploy on Pethost**.
2. Sign in, or create an account and choose a plan if you don't already have one.
3. Click **Create project**. The template generates `OPENCLAW_GATEWAY_TOKEN` and writes it to the project's `.env`.
4. Wait for the deployment to complete, then open the project's address, `https://openclaw.<your-account>.pethost.app`.
5. Copy `OPENCLAW_GATEWAY_TOKEN` from the project's `.env` in the Pethost panel, paste it into **Gateway secret**, and click **Connect**.
6. Approve the browser once. Open the terminal of the `openclaw` service in the Pethost panel and run:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

See [Device pairing](/web/control-ui/connect-and-pair#device-pairing-first-connection).

## What you get

- Hosted OpenClaw Gateway + Control UI at an HTTPS address, with `gateway.controlUi.allowedOrigins` set to that address and `gateway.trustedProxies` to Pethost's proxy network
- Named volumes at `/home/node/.openclaw` (config, state, and the default workspace) and `/home/node/.config/openclaw`, kept across deploys

## Connect a channel

Set up a channel from the Control UI, as on any Gateway:

- [Discord](/channels/discord)
- [Telegram](/channels/telegram) (fastest, just a bot token)
- [Channels](/channels)

## Updating

The template pins a release of the official image. To update, change the image tag in the project's `compose.yaml` in the Pethost panel and deploy again.

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep OpenClaw up to date: [Updating](/install/updating)
