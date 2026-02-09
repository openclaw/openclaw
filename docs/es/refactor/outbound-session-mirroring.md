---
title: refactor/outbound-session-mirroring.md #1520)
description: Seguimiento de notas, decisiones, pruebas y elementos abiertos de la refactorización del espejado de sesiones salientes.
---

# Refactorización del Espejado de Sesiones Salientes (Issue #1520)

## Estado

- En progreso.
- Enrutamiento de canales del núcleo + plugins actualizado para el espejado saliente.
- El envío del Gateway ahora deriva la sesión de destino cuando se omite sessionKey.

## Contexto

Los envíos salientes se espejaban en la sesión _actual_ del agente (clave de sesión de la herramienta) en lugar de la sesión del canal de destino. El enrutamiento entrante usa claves de sesión de canal/par, por lo que las respuestas salientes aterrizaban en la sesión incorrecta y los objetivos de primer contacto a menudo carecían de entradas de sesión.

## Objetivos

- Espejar los mensajes salientes en la clave de sesión del canal de destino.
- Crear entradas de sesión en envíos salientes cuando falten.
- Mantener el alcance de hilos/temas alineado con las claves de sesión entrantes.
- Cubrir los canales del núcleo y las extensiones incluidas.

## Resumen de Implementación

- Nuevo helper de enrutamiento de sesiones salientes:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` construye la sessionKey de destino usando `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` escribe un `MsgContext` mínimo mediante `recordSessionMetaFromInbound`.
- `runMessageAction` (send) deriva la sessionKey de destino y la pasa a `executeSendAction` para el espejado.
- `message-tool` ya no espeja directamente; solo resuelve agentId desde la clave de sesión actual.
- La ruta de envío del plugin espeja vía `appendAssistantMessageToSessionTranscript` usando la sessionKey derivada.
- El envío del Gateway deriva una clave de sesión de destino cuando no se proporciona (agente predeterminado) y garantiza una entrada de sesión.

## Manejo de hilo/tema

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (sufijo).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` con `useSuffix=false` para coincidir con lo entrante (el id del canal del hilo ya delimita la sesión).
- Telegram: los IDs de tema se asignan a `chatId:topic:<id>` mediante `buildTelegramGroupPeerId`.

## Extensiones Cubiertas

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notas:
  - Los destinos de Mattermost ahora eliminan `@` para el enrutamiento de claves de sesión de DM.
  - Zalo Personal usa el tipo de par DM para objetivos 1:1 (grupo solo cuando está presente `group:`).
  - Los destinos de grupo de BlueBubbles eliminan los prefijos `chat_*` para coincidir con las claves de sesión entrantes.
  - El espejado automático de hilos de Slack coincide con los IDs de canal sin distinguir mayúsculas/minúsculas.
  - El envío del Gateway convierte a minúsculas las claves de sesión proporcionadas antes de espejar.

## Decisiones

- **Derivación de sesión en el envío del Gateway**: si se proporciona `sessionKey`, úselo. Si se omite, derive una sessionKey a partir del destino + el agente predeterminado y espeje allí.
- **Creación de entradas de sesión**: use siempre `recordSessionMetaFromInbound` con `Provider/From/To/ChatType/AccountId/Originating*` alineado a los formatos entrantes.
- **Normalización de destinos**: el enrutamiento saliente usa destinos resueltos (post `resolveChannelTarget`) cuando están disponibles.
- **Uso de mayúsculas/minúsculas en claves de sesión**: canonizar las claves de sesión a minúsculas al escribir y durante las migraciones.

## Pruebas Agregadas/Actualizadas

- `src/infra/outbound/outbound-session.test.ts`
  - Clave de sesión de hilo de Slack.
  - Clave de sesión de tema de Telegram.
  - dmScope identityLinks con Discord.
- `src/agents/tools/message-tool.test.ts`
  - Deriva agentId desde la clave de sesión (no se pasa sessionKey).
- `src/gateway/server-methods/send.test.ts`
  - Deriva la clave de sesión cuando se omite y crea una entrada de sesión.

## Elementos Abiertos / Seguimientos

- El plugin de llamadas de voz usa claves de sesión `voice:<phone>` personalizadas. El mapeo saliente no está estandarizado aquí; si la herramienta de mensajes debe admitir envíos de llamadas de voz, agregue un mapeo explícito.
- Confirmar si algún plugin externo usa formatos `From/To` no estándar más allá del conjunto incluido.

## Archivos Modificados

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Pruebas en:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
