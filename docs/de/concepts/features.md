---
summary: „OpenClaw‑Funktionen über Kanäle, Routing, Medien und UX hinweg.“
read_when:
  - Sie möchten eine vollständige Liste dessen, was OpenClaw unterstützt
title: „Funktionen“
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:53Z
---

## Höhepunkte

<Columns>
  <Card title="Kanäle" icon="message-square">
    WhatsApp, Telegram, Discord und iMessage mit einem einzigen Gateway.
  </Card>
  <Card title="Plugins" icon="plug">
    Fügen Sie Mattermost und mehr mit Erweiterungen hinzu.
  </Card>
  <Card title="Routing" icon="route">
    Multi‑Agent‑Routing mit isolierten Sitzungen.
  </Card>
  <Card title="Medien" icon="image">
    Bilder, Audio und Dokumente ein‑ und ausgehend.
  </Card>
  <Card title="Apps und UI" icon="monitor">
    Web‑Control‑UI und macOS‑Companion‑App.
  </Card>
  <Card title="Mobile Nodes" icon="smartphone">
    iOS‑ und Android‑Nodes mit Canvas‑Unterstützung.
  </Card>
</Columns>

## Vollständige Liste

- WhatsApp‑Integration über WhatsApp Web (Baileys)
- Telegram‑Bot‑Unterstützung (grammY)
- Discord‑Bot‑Unterstützung (channels.discord.js)
- Mattermost‑Bot‑Unterstützung (Plugin)
- iMessage‑Integration über lokale imsg CLI (macOS)
- Agent‑Bridge für Pi im RPC‑Modus mit Werkzeug‑Streaming
- Streaming und Chunking für lange Antworten
- Multi‑Agent‑Routing für isolierte Sitzungen pro Workspace oder Absender
- Abonnement‑Authentifizierung für Anthropic und OpenAI über OAuth
- Sitzungen: Direktchats werden in `main` zusammengeführt; Gruppen sind isoliert
- Gruppenchat‑Unterstützung mit erwähnungsbasierter Aktivierung
- Medienunterstützung für Bilder, Audio und Dokumente
- Optionaler Hook zur Transkription von Sprachnotizen
- WebChat und macOS‑Menüleisten‑App
- iOS‑Node mit Pairing und Canvas‑Oberfläche
- Android‑Node mit Pairing, Canvas, Chat und Kamera

<Note>
Legacy‑Pfade für Claude, Codex, Gemini und Opencode wurden entfernt. Pi ist der einzige
Coding‑Agent‑Pfad.
</Note>
