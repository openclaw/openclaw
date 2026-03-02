---
summary: "channels, routing, media, and UX 전반에 걸쳐 OpenClaw 기능."
read_when:
  - OpenClaw가 지원하는 전체 목록을 원할 때
title: "Features"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/features.md
  workflow: 15
---

## Highlights

<Columns>
  <Card title="Channels" icon="message-square">
    하나의 Gateway로 WhatsApp, Telegram, Discord 및 iMessage.
  </Card>
  <Card title="Plugins" icon="plug">
    Extensions로 Mattermost 등을 추가합니다.
  </Card>
  <Card title="Routing" icon="route">
    isolated sessions로 multi-agent routing.
  </Card>
  <Card title="Media" icon="image">
    이미지, 오디오 및 in and out 문서.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI 및 macOS companion app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Canvas support를 포함한 iOS 및 Android nodes.
  </Card>
</Columns>

## Full list

- WhatsApp Web를 통한 WhatsApp 통합 (Baileys)
- Telegram bot support (grammY)
- Discord bot support (channels.discord.js)
- Mattermost bot support (plugin)
- local imsg CLI를 통한 iMessage 통합 (macOS)
- RPC mode에서 Pi를 위한 Agent bridge with tool streaming
- long responses에 대한 Streaming 및 chunking
- isolated sessions이 있는 multi-agent routing for per workspace or sender
- Anthropic 및 OpenAI를 위한 Subscription auth via OAuth
- Sessions: direct chats collapse to shared `main`; groups are isolated
- mention based activation을 포함한 Group chat support
- 이미지, 오디오 및 문서를 위한 Media support
- Optional voice note transcription hook
- WebChat 및 macOS menu bar app
- iOS node with pairing 및 Canvas surface
- Android node with pairing, Canvas, chat, 및 camera

<Note>
Legacy Claude, Codex, Gemini, and Opencode paths가 제거되었습니다. Pi는 유일한 coding agent path입니다.
</Note>
