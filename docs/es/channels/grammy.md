---
summary: "Integración de la API de Bots de Telegram mediante grammY con notas de configuración"
read_when:
  - Trabajando en rutas de Telegram o grammY
title: grammY
---

# Integración de grammY (API de Bots de Telegram)

# Por qué grammY

- Cliente de la API de Bots con enfoque en TS, con helpers integrados para long-poll y webhooks, middleware, manejo de errores y limitador de tasa.
- Helpers de medios más limpios que implementar fetch + FormData a mano; compatible con todos los métodos de la API de Bots.
- Extensible: soporte de proxy mediante fetch personalizado, middleware de sesiones (opcional) y contexto con tipado seguro.

# Qué enviamos

- **Ruta de cliente única:** se eliminó la implementación basada en fetch; grammY es ahora el único cliente de Telegram (envío + Gateway) con el limitador de grammY habilitado por defecto.
- **Gateway:** `monitorTelegramProvider` construye un `Bot` de grammY, conecta el control de menciones/lista de permitidos, descarga de medios mediante `getFile`/`download`, y entrega respuestas con `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Admite long-poll o webhook mediante `webhookCallback`.
- **Proxy:** el `channels.telegram.proxy` opcional usa `undici.ProxyAgent` a través de `client.baseFetch` de grammY.
- **Soporte de webhook:** `webhook-set.ts` envuelve `setWebhook/deleteWebhook`; `webhook.ts` aloja el callback con salud + apagado gradual. El Gateway habilita el modo webhook cuando se establecen `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (de lo contrario usa long-poll).
- **Sesiones:** los chats directos se colapsan en la sesión principal del agente (`agent:<agentId>:<mainKey>`); los grupos usan `agent:<agentId>:telegram:group:<chatId>`; las respuestas regresan al mismo canal.
- **Perillas de configuración:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (lista de permitidos + valores predeterminados de menciones), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Streaming de borradores:** el `channels.telegram.streamMode` opcional usa `sendMessageDraft` en chats de temas privados (API de Bots 9.3+). Esto es independiente del streaming por bloques del canal.
- **Pruebas:** los mocks de grammY cubren el control de menciones en mensajes directos y grupos, y el envío saliente; aún se agradecen más fixtures de medios/webhooks.

Preguntas abiertas

- Plugins opcionales de grammY (limitador) si encontramos errores 429 de la API de Bots.
- Agregar más pruebas estructuradas de medios (stickers, notas de voz).
- Hacer configurable el puerto de escucha del webhook (actualmente fijo en 8787 a menos que se conecte a través del Gateway).
