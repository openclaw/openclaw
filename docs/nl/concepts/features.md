---
summary: "OpenClaw-mogelijkheden over kanalen, routering, media en UX."
read_when:
  - Je wilt een volledige lijst van wat OpenClaw ondersteunt
title: "Functies"
---

## Hoogtepunten

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord en iMessage met één Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Voeg Mattermost en meer toe met extensies.
  </Card>
  <Card title="Routing" icon="route">
    Multi-agent-routering met geïsoleerde sessies.
  </Card>
  <Card title="Media" icon="image">
    Afbeeldingen, audio en documenten in en uit.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI en macOS Companion-app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
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
