---
summary: "OpenClaw-funktioner på tværs af kanaler, routing, medier og UX."
read_when:
  - Du vil have en komplet liste over, hvad OpenClaw understøtter
title: "Funktioner"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:07Z
---

## Højdepunkter

<Columns>
  <Card title="Kanaler" icon="message-square">
    WhatsApp, Telegram, Discord og iMessage med en enkelt Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Tilføj Mattermost og mere med udvidelser.
  </Card>
  <Card title="Routing" icon="route">
    Multi-agent-routing med isolerede sessioner.
  </Card>
  <Card title="Medier" icon="image">
    Billeder, lyd og dokumenter ind og ud.
  </Card>
  <Card title="Apps og UI" icon="monitor">
    Web Control UI og macOS companion-app.
  </Card>
  <Card title="Mobile noder" icon="smartphone">
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
Ældre Claude-, Codex-, Gemini- og Opencode-stier er fjernet. Pi er den eneste
coding agent-sti.
</Note>
