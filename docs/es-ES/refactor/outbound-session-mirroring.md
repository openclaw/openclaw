---
title: Refactorización de Espejado de Sesiones Salientes (Issue #1520)
description: Seguimiento de notas de refactorización de espejado de sesiones salientes, decisiones, pruebas y elementos abiertos.
---

# Refactorización de Espejado de Sesiones Salientes (Issue #1520)

## Estado

- En progreso.
- Enrutamiento de canales core + plugin actualizado para espejado saliente.
- Gateway send ahora deriva sesión objetivo cuando sessionKey es omitido.

## Contexto

Los envíos salientes se espejeaban en la sesión del agente _actual_ (clave de sesión de herramienta) en lugar de la sesión del canal objetivo. El enrutamiento entrante usa claves de sesión de canal/par, por lo que las respuestas salientes aterrizaban en la sesión equivocada y los objetivos de primer contacto a menudo carecían de entradas de sesión.

## Objetivos

- Espejar mensajes salientes en la clave de sesión del canal objetivo.
- Crear entradas de sesión en salientes cuando falten.
- Mantener el alcance de hilo/tema alineado con claves de sesión entrantes.
- Cubrir canales core más extensiones incluidas.

## Resumen de implementación

- Nuevo helper de enrutamiento de sesión saliente:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` construye sessionKey objetivo usando `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` escribe `MsgContext` mínimo vía `recordSessionMetaFromInbound`.
- `runMessageAction` (send) deriva sessionKey objetivo y lo pasa a `executeSendAction` para espejado.
- `message-tool` ya no espejea directamente; solo resuelve agentId de la clave de sesión actual.
- Ruta de envío de plugin espejea vía `appendAssistantMessageToSessionTranscript` usando el sessionKey derivado.
- Gateway send deriva una clave de sesión objetivo cuando no se proporciona ninguna (agente predeterminado), y asegura una entrada de sesión.

## Manejo de hilo/tema

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (sufijo).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` con `useSuffix=false` para coincidir con entrante (id de canal de hilo ya alcanza sesión).
- Telegram: IDs de tema mapean a `chatId:topic:<id>` vía `buildTelegramGroupPeerId`.

## Extensiones cubiertas

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Notas:
  - Los objetivos de Mattermost ahora eliminan `@` para enrutamiento de clave de sesión DM.
  - Zalo Personal usa tipo de par DM para objetivos 1:1 (grupo solo cuando `group:` está presente).
  - Los objetivos de grupo de BlueBubbles eliminan prefijos `chat_*` para coincidir con claves de sesión entrantes.
  - El espejado de auto-hilo de Slack coincide con ids de canal sin distinguir mayúsculas/minúsculas.
  - Gateway send pone en minúsculas las claves de sesión proporcionadas antes de espejar.

## Decisiones

- **Derivación de sesión de Gateway send**: si se proporciona `sessionKey`, usarla. Si se omite, derivar un sessionKey del objetivo + agente predeterminado y espejar allí.
- **Creación de entrada de sesión**: usar siempre `recordSessionMetaFromInbound` con `Provider/From/To/ChatType/AccountId/Originating*` alineados a formatos entrantes.
- **Normalización de objetivo**: el enrutamiento saliente usa objetivos resueltos (post `resolveChannelTarget`) cuando están disponibles.
- **Capitalización de clave de sesión**: canonicalizar claves de sesión a minúsculas en escritura y durante migraciones.

## Pruebas agregadas/actualizadas

- `src/infra/outbound/outbound-session.test.ts`
  - Clave de sesión de hilo de Slack.
  - Clave de sesión de tema de Telegram.
  - identityLinks de dmScope con Discord.
- `src/agents/tools/message-tool.test.ts`
  - Deriva agentId de clave de sesión (sin sessionKey pasado).
- `src/gateway/server-methods/send.test.ts`
  - Deriva clave de sesión cuando se omite y crea entrada de sesión.

## Elementos abiertos / seguimientos

- El plugin voice-call usa claves de sesión personalizadas `voice:<phone>`. El mapeo saliente no está estandarizado aquí; si message-tool debe soportar envíos de voice-call, agregar mapeo explícito.
- Confirmar si algún plugin externo usa formatos `From/To` no estándar más allá del conjunto incluido.

## Archivos tocados

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Pruebas en:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
