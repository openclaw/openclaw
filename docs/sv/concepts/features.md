---
summary: "”OpenClaw-funktioner över kanaler, routing, media och UX.”"
read_when:
  - Du vill ha en fullständig lista över vad OpenClaw stöder
title: "”Funktioner”"
---

## Höjdpunkter

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord och iMessage med en enda Gateway (nätverksgateway).
  </Card>
  <Card title="Plugins" icon="plug">
    Lägg till Mattermost och mer med tillägg.
  </Card>
  <Card title="Routing" icon="route">
    Routing med flera agenter och isolerade sessioner.
  </Card>
  <Card title="Media" icon="image">
    Bilder, ljud och dokument in och ut.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI och macOS companion-app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    iOS- och Android-noder med Canvas-stöd.
  </Card>
</Columns>

## Fullständig lista

- WhatsApp-integration via WhatsApp Web (Baileys)
- Stöd för Telegram-bot (grammY)
- Stöd för Discord-bot (channels.discord.js)
- Stöd för Mattermost-bot (plugin)
- iMessage-integration via lokal imsg CLI (macOS)
- Agentbrygga för Pi i RPC-läge med verktygsströmning
- Strömning och chunking för långa svar
- Routing med flera agenter för isolerade sessioner per arbetsyta eller avsändare
- Prenumerationsautentisering för Anthropic och OpenAI via OAuth
- Sessioner: direkta chattar slås samman till delade `main`; grupper är isolerade
- Stöd för gruppchattar med aktivering baserad på omnämnanden
- Mediestöd för bilder, ljud och dokument
- Valfri hook för transkribering av röstmeddelanden
- WebChat och macOS-menyradsapp
- iOS-nod med parkoppling och Canvas-yta
- Android-nod med parkoppling, Canvas, chatt och kamera

<Note>
Legacy Claude, Codex, Gemini och Opencode sökvägar har tagits bort. Pi är den enda sökvägen för
kodningsagenten.
</Note>
