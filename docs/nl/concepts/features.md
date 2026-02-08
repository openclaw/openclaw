---
summary: "OpenClaw-mogelijkheden over kanalen, routering, media en UX."
read_when:
  - Je wilt een volledige lijst van wat OpenClaw ondersteunt
title: "Functies"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:18Z
---

## Hoogtepunten

<Columns>
  <Card title="Kanalen" icon="message-square">
    WhatsApp, Telegram, Discord en iMessage met één Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Voeg Mattermost en meer toe met extensies.
  </Card>
  <Card title="Routering" icon="route">
    Multi-agent-routering met geïsoleerde sessies.
  </Card>
  <Card title="Media" icon="image">
    Afbeeldingen, audio en documenten in en uit.
  </Card>
  <Card title="Apps en UI" icon="monitor">
    Web Control UI en macOS Companion-app.
  </Card>
  <Card title="Mobiele nodes" icon="smartphone">
    iOS- en Android-nodes met Canvas-ondersteuning.
  </Card>
</Columns>

## Volledige lijst

- WhatsApp-integratie via WhatsApp Web (Baileys)
- Telegram-botondersteuning (grammY)
- Discord-botondersteuning (channels.discord.js)
- Mattermost-botondersteuning (plugin)
- iMessage-integratie via lokale imsg CLI (macOS)
- Agent-bridge voor Pi in RPC-modus met toolstreaming
- Streaming en chunking voor lange antwoorden
- Multi-agent-routering voor geïsoleerde sessies per werkruimte of afzender
- Abonnementsauthenticatie voor Anthropic en OpenAI via OAuth
- Sessies: directe chats worden samengevouwen in gedeelde `main`; groepen zijn geïsoleerd
- Ondersteuning voor groepschats met activatie op basis van mentions
- Media-ondersteuning voor afbeeldingen, audio en documenten
- Optionele hook voor transcriptie van spraaknotities
- WebChat en macOS-menubalkapp
- iOS-node met koppeling en Canvas-oppervlak
- Android-node met koppeling, Canvas, chat en camera

<Note>
Verouderde paden voor Claude, Codex, Gemini en Opencode zijn verwijderd. Pi is het enige
pad voor codeeragents.
</Note>
