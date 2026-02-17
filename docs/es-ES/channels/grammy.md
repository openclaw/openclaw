---
summary: "Integración con la API de Bot de Telegram mediante grammY con notas de configuración"
read_when:
  - Trabajando en rutas de Telegram o grammY
title: grammY
---

# Integración grammY (API de Bot de Telegram)

# Por qué grammY

- Cliente de API de Bot con prioridad en TypeScript con ayudantes integrados de long-poll + webhook, middleware, manejo de errores, limitador de tasa.
- Ayudantes de medios más limpios que crear fetch + FormData manualmente; admite todos los métodos de la API de Bot.
- Extensible: soporte de proxy mediante fetch personalizado, middleware de sesión (opcional), contexto con seguridad de tipos.

# Lo que enviamos

- **Ruta de cliente única:** implementación basada en fetch eliminada; grammY es ahora el único cliente de Telegram (envío + gateway) con el limitador de grammY habilitado por defecto.
- **Gateway:** `monitorTelegramProvider` construye un `Bot` de grammY, conecta control de menciones/listas de permitidos, descarga de medios mediante `getFile`/`download`, y entrega respuestas con `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Admite long-poll o webhook mediante `webhookCallback`.
- **Proxy:** `channels.telegram.proxy` opcional utiliza `undici.ProxyAgent` a través de `client.baseFetch` de grammY.
- **Soporte de webhook:** `webhook-set.ts` envuelve `setWebhook/deleteWebhook`; `webhook.ts` aloja el callback con salud + apagado gracioso. El gateway habilita el modo webhook cuando se establecen `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (de lo contrario hace long-poll).
- **Sesiones:** los chats directos se consolidan en la sesión principal del agente (`agent:<agentId>:<mainKey>`); los grupos utilizan `agent:<agentId>:telegram:group:<chatId>`; las respuestas se enrutan de vuelta al mismo canal.
- **Configuraciones:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (lista de permitidos + menciones predeterminadas), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`, `channels.telegram.webhookHost`.
- **Vista previa de transmisión en vivo:** `channels.telegram.streamMode` opcional envía un mensaje temporal y lo actualiza con `editMessageText`. Esto es independiente del streaming de bloques del canal.
- **Pruebas:** los mocks de grammY cubren el control de mensajes directos + menciones de grupo y envío de salida; más fixtures de medios/webhook aún son bienvenidos.

Preguntas abiertas

- Plugins opcionales de grammY (limitador) si recibimos 429 de la API de Bot.
- Añadir más pruebas estructuradas de medios (stickers, notas de voz).
- Hacer configurable el puerto de escucha del webhook (actualmente fijo en 8787 a menos que se conecte a través del gateway).
