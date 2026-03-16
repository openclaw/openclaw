---
summary: "Référence CLI pour `openclaw voicecall` (surface de commande du plugin voice-call)"
read_when:
  - Vous utilisez le plugin voice-call et voulez les points d'entrée CLI
  - Vous voulez des exemples rapides pour `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` est une commande fournie par plugin. Elle n'apparaît que si le plugin voice-call est installé et activé.

Doc principale :

- Plugin Voice-call : [Voice Call](/fr-FR/plugins/voice-call)

## Commandes courantes

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Bonjour" --mode notify
openclaw voicecall continue --call-id <id> --message "Des questions ?"
openclaw voicecall end --call-id <id>
```

## Exposer les webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Note de sécurité : n'exposez le point de terminaison webhook qu'aux réseaux en lesquels vous avez confiance. Préférez Tailscale Serve à Funnel quand possible.
