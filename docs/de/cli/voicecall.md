---
summary: "CLI-Referenz für `openclaw voicecall` (Befehlsoberfläche des Voice-Call-Plugins)"
read_when:
  - Sie das Voice-Call-Plugin verwenden und die CLI-Einstiegspunkte benötigen
  - Sie schnelle Beispiele für `voicecall call|continue|status|tail|expose` wünschen
title: "voicecall"
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
