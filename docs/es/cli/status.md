---
summary: "Referencia de la CLI para `openclaw status` (diagnósticos, sondeos, instantáneas de uso)"
read_when:
  - Quiere un diagnóstico rápido de la salud del canal + destinatarios de sesiones recientes
  - Quiere un estado “all” pegable para depuración
title: "estado"
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
- La salida incluye almacenes de sesión por agente cuando hay múltiples agentes configurados.
- La vista general incluye el estado de instalación/ejecución del Gateway (puerta de enlace) + el servicio del host del nodo cuando está disponible.
- La vista general incluye el canal de actualización + el SHA de git (para checkouts desde el código fuente).
- La información de actualización aparece en la vista general; si hay una actualización disponible, el estado muestra una sugerencia para ejecutar `openclaw update` (ver [Updating](/install/updating)).
