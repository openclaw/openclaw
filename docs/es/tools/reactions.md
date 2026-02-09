---
summary: "Semántica de reacciones compartida entre canales"
read_when:
  - Trabajando en reacciones en cualquier canal
title: "Reacciones"
---

# Herramientas de reacciones

Semántica de reacciones compartida entre canales:

- `emoji` es obligatorio al agregar una reacción.
- `emoji=""` elimina la(s) reacción(es) del bot cuando es compatible.
- `remove: true` elimina el emoji especificado cuando es compatible (requiere `emoji`).

Notas por canal:

- **Discord/Slack**: un `emoji` vacío elimina todas las reacciones del bot en el mensaje; `remove: true` elimina solo ese emoji.
- **Google Chat**: un `emoji` vacío elimina las reacciones de la app en el mensaje; `remove: true` elimina solo ese emoji.
- **Telegram**: un `emoji` vacío elimina las reacciones del bot; `remove: true` también elimina reacciones, pero aún requiere un `emoji` no vacío para la validación de la herramienta.
- **WhatsApp**: un `emoji` vacío elimina la reacción del bot; `remove: true` se asigna a un emoji vacío (aún requiere `emoji`).
- **Signal**: las notificaciones de reacciones entrantes emiten eventos del sistema cuando `channels.signal.reactionNotifications` está habilitado.
