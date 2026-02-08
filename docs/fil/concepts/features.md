---
summary: "Mga kakayahan ng OpenClaw sa iba’t ibang channel, routing, media, at UX."
read_when:
  - Gusto mo ng kumpletong listahan ng sinusuportahan ng OpenClaw
title: "Mga tampok"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:18Z
---

## Mga highlight

<Columns>
  <Card title="Mga channel" icon="message-square">
    WhatsApp, Telegram, Discord, at iMessage gamit ang iisang Gateway.
  </Card>
  <Card title="Mga plugin" icon="plug">
    Magdagdag ng Mattermost at iba pa gamit ang mga extension.
  </Card>
  <Card title="Routing" icon="route">
    Multi-agent routing na may mga nakahiwalay na session.
  </Card>
  <Card title="Media" icon="image">
    Mga larawan, audio, at dokumento papasok at palabas.
  </Card>
  <Card title="Apps at UI" icon="monitor">
    Web Control UI at macOS companion app.
  </Card>
  <Card title="Mga mobile node" icon="smartphone">
    Mga iOS at Android node na may suporta sa Canvas.
  </Card>
</Columns>

## Buong listahan

- Integrasyon ng WhatsApp sa pamamagitan ng WhatsApp Web (Baileys)
- Suporta sa Telegram bot (grammY)
- Suporta sa Discord bot (channels.discord.js)
- Suporta sa Mattermost bot (plugin)
- Integrasyon ng iMessage sa pamamagitan ng lokal na imsg CLI (macOS)
- Agent bridge para sa Pi sa RPC mode na may tool streaming
- Streaming at chunking para sa mahahabang tugon
- Multi-agent routing para sa mga nakahiwalay na session kada workspace o sender
- Subscription auth para sa Anthropic at OpenAI sa pamamagitan ng OAuth
- Mga session: ang mga direct chat ay pinagsasama sa shared `main`; ang mga group ay hiwalay
- Suporta sa group chat na may activation batay sa mention
- Suporta sa media para sa mga larawan, audio, at dokumento
- Opsyonal na hook para sa transcription ng voice note
- WebChat at macOS menu bar app
- iOS node na may pairing at Canvas surface
- Android node na may pairing, Canvas, chat, at camera

<Note>
Inalis na ang mga legacy path ng Claude, Codex, Gemini, at Opencode. Ang Pi na lang ang
coding agent path.
</Note>
