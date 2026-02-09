---
summary: "OpenClaw capabilities across channels, routing, media, and UX."
read_when:
  - You want a full list of what OpenClaw supports
title: "Features"
---

## Highlights

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord, and iMessage with a single Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Add Mattermost and more with extensions.
  </Card>
  <Card title="Routing" icon="route">
    Multi-agent routing with isolated sessions.
  </Card>
  <Card title="Media" icon="image">
    Images, audio, and documents in and out.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI and macOS companion app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    iOS and Android nodes with Canvas support.
  </Card>
</Columns>

## Full list

- WhatsApp integration via WhatsApp Web (Baileys)
- Telegram bot support (grammY)
- Discord bot support (channels.discord.js)
- Mattermost bot support (plugin)
- iMessage integration via local imsg CLI (macOS)
- Agent bridge for Pi in RPC mode with tool streaming
- Streaming and chunking for long responses
- Multi-agent routing for isolated sessions per workspace or sender
- Subscription auth for Anthropic and OpenAI via OAuth
- Sessions: direct chats collapse into shared `main`; groups are isolated
- Group chat support with mention based activation
- Media support for images, audio, and documents
- Optional voice note transcription hook
- WebChat and macOS menu bar app
- iOS node with pairing and Canvas surface
- Android node with pairing, Canvas, chat, and camera

<Note>
Legacy Claude, Codex, Gemini, and Opencode paths have been removed. Pi is the only
coding agent path.
</Note>
