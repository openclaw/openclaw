---
summary: "Referencia CLI para `openclaw status` (diagnósticos, sondeos, instantáneas de uso)"
read_when:
  - Quieres un diagnóstico rápido de salud de canales + destinatarios de sesión recientes
  - Quieres un estado "all" copiable para depuración
title: "status"
---

# `openclaw status`

Diagnósticos para canales + sesiones.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notas:

- `--deep` ejecuta sondeos en vivo (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- La salida incluye almacenes de sesión por agente cuando se configuran múltiples agentes.
- La descripción general incluye el estado de instalación/ejecución del servicio host del Gateway + nodo cuando está disponible.
- La descripción general incluye canal de actualización + SHA de git (para checkouts de código fuente).
- La información de actualización aparece en la descripción general; si hay una actualización disponible, status imprime una sugerencia para ejecutar `openclaw update` (ver [Actualizando](/es-ES/install/updating)).
