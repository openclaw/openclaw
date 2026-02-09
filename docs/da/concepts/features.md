---
summary: "OpenClaw-funktioner på tværs af kanaler, routing, medier og UX."
read_when:
  - Du vil have en komplet liste over, hvad OpenClaw understøtter
title: "Funktioner"
---

## Højdepunkter

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord og iMessage med en enkelt Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Tilføj Mattermost og mere med udvidelser.
  </Card>
  <Card title="Routing" icon="route">
    Multi-agent-routing med isolerede sessioner.
  </Card>
  <Card title="Media" icon="image">
    Billeder, lyd og dokumenter ind og ud.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI og macOS companion-app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    iOS- og Android-noder med Canvas-understøttelse.
  </Card>
</Columns>

## Fuld liste

- WhatsApp-integration via WhatsApp Web (Baileys)
- Telegram-botunderstøttelse (grammY)
- Discord-botunderstøttelse (channels.discord.js)
- Mattermost-botunderstøttelse (plugin)
- iMessage-integration via lokal imsg CLI (macOS)
- Agent-bro for Pi i RPC-tilstand med værktøjsstreaming
- Streaming og chunking for lange svar
- Multi-agent-routing for isolerede sessioner pr. workspace eller afsender
- Abonnementsautentificering for Anthropic og OpenAI via OAuth
- Sessioner: direkte chats samles i delt `main`; grupper er isolerede
- Understøttelse af gruppechats med aktivering baseret på omtale
- Medieunderstøttelse for billeder, lyd og dokumenter
- Valgfri hook til transskription af stemmenoter
- WebChat og macOS-menulinjeapp
- iOS-node med parring og Canvas-overflade
- Android-node med parring, Canvas, chat og kamera

<Note>
Legacy Claude, Codex, Gemini og Opencode stier er blevet fjernet. Pi er den eneste
kodning agent sti.
</Note>
