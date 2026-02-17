---
summary: "Referencia CLI para `openclaw voicecall` (superficie de comandos del plugin voice-call)"
read_when:
  - Usas el plugin voice-call y quieres los puntos de entrada CLI
  - Quieres ejemplos rápidos para `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` es un comando proporcionado por plugin. Solo aparece si el plugin voice-call está instalado y habilitado.

Documentación principal:

- Plugin voice-call: [Llamada de Voz](/es-ES/plugins/voice-call)

## Comandos comunes

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hola" --mode notify
openclaw voicecall continue --call-id <id> --message "¿Alguna pregunta?"
openclaw voicecall end --call-id <id>
```

## Exponer webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Nota de seguridad: solo expone el endpoint de webhook a redes en las que confíes. Prefiere Tailscale Serve sobre Funnel cuando sea posible.
