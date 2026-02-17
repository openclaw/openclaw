---
summary: "Semántica de reacciones compartida entre canales"
read_when:
  - Trabajar con reacciones en cualquier canal
title: "Reacciones"
---

# Herramienta de reacciones

Semántica de reacciones compartida entre canales:

- `emoji` es requerido al agregar una reacción.
- `emoji=""` elimina la(s) reacción(es) del bot cuando es compatible.
- `remove: true` elimina el emoji especificado cuando es compatible (requiere `emoji`).

Notas de canal:

- **Discord/Slack**: `emoji` vacío elimina todas las reacciones del bot en el mensaje; `remove: true` elimina solo ese emoji.
- **Google Chat**: `emoji` vacío elimina las reacciones de la aplicación en el mensaje; `remove: true` elimina solo ese emoji.
- **Telegram**: `emoji` vacío elimina las reacciones del bot; `remove: true` también elimina reacciones pero aún requiere un `emoji` no vacío para validación de herramienta.
- **WhatsApp**: `emoji` vacío elimina la reacción del bot; `remove: true` se mapea a emoji vacío (aún requiere `emoji`).
- **Signal**: las notificaciones de reacción entrantes emiten eventos del sistema cuando `channels.signal.reactionNotifications` está habilitado.
