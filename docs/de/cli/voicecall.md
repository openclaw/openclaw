---
summary: "CLI-Referenz für `openclaw voicecall` (Befehlsoberfläche des Voice-Call-Plugins)"
read_when:
  - Sie das Voice-Call-Plugin verwenden und die CLI-Einstiegspunkte benötigen
  - Sie schnelle Beispiele für `voicecall call|continue|status|tail|expose` wünschen
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:43Z
---

# `openclaw voicecall`

`voicecall` ist ein vom Plugin bereitgestellter Befehl. Er erscheint nur, wenn das Voice-Call-Plugin installiert und aktiviert ist.

Hauptdokumentation:

- Voice-Call-Plugin: [Voice Call](/plugins/voice-call)

## Häufige Befehle

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Webhooks verfügbar machen (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Sicherheitshinweis: Stellen Sie den Webhook-Endpunkt nur Netzwerken zur Verfügung, denen Sie vertrauen. Bevorzugen Sie nach Möglichkeit Tailscale Serve gegenüber Funnel.
