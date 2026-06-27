---
summary: "Run OpenClaw as a fully managed, hosted instance with OpenClaw Launch"
read_when:
  - You want OpenClaw running without provisioning or maintaining a server
  - You want a hosted Gateway with channels and SSL handled for you
title: "OpenClaw Launch"
---

# OpenClaw Launch

[OpenClaw Launch](https://openclawlaunch.com) is a third-party managed hosting service
for OpenClaw. Instead of installing OpenClaw and running the Gateway on your own machine
or VPS, you configure a bot in the browser and it deploys a managed, isolated instance
for you, with channels, storage, and SSL handled automatically.

This is the no-install option. If you prefer to run OpenClaw yourself, see the other
guides in this section (for example [Docker](/install/docker), [Hetzner](/install/hetzner),
or any [VPS](/vps)).

<Note>
OpenClaw Launch is an independent commercial service, not operated by the OpenClaw
project. Pricing and support are handled by OpenClaw Launch.
</Note>

## What it handles for you

- Provisioning and running the OpenClaw Gateway in an isolated container
- Channel setup for Telegram, Discord, WhatsApp, and browser-based web chat
- TLS/HTTPS certificates and a reverse proxy
- Persistent storage for chat history and workspace files
- Updates and basic monitoring

## Prerequisites

- An account at [openclawlaunch.com](https://openclawlaunch.com)
- An API key from your preferred [model provider](/providers), or use the bundled
  credits included with a plan

## Deploy

1. Sign in at [openclawlaunch.com](https://openclawlaunch.com).
2. Configure your bot: pick a model, the channels you want, and any skills.
3. Click Deploy. A managed instance is provisioned and your bot comes online,
   typically in under a minute.
4. Connect a channel (for example, pair a Telegram bot) and start chatting.

## Bring your own keys

You can supply your own model-provider API keys (OpenAI, Anthropic, Google, OpenRouter,
and others), or use credits included with a plan. Keys are stored encrypted at rest.

## Notes

- Each instance runs in its own container with dedicated storage.
- Because the Gateway is hosted, you manage configuration through the OpenClaw Launch
  dashboard rather than a local `openclaw.json`.
- For self-hosted control over the full OpenClaw CLI and config, use one of the
  self-install methods in this section instead.
