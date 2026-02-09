---
summary: "Host estático de WebChat en loopback y uso de WS del Gateway para la UI de chat"
read_when:
  - Depuración o configuración del acceso a WebChat
title: "WebChat"
---

# WebChat (UI WebSocket del Gateway)

Estado: la UI de chat SwiftUI de macOS/iOS se comunica directamente con el WebSocket del Gateway.

## Qué es

- Una UI de chat nativa para el Gateway (sin navegador integrado ni servidor estático local).
- Usa las mismas sesiones y reglas de enrutamiento que otros canales.
- Enrutamiento determinista: las respuestas siempre regresan a WebChat.

## Inicio rápido

1. Inicie el Gateway.
2. Abra la UI de WebChat (app de macOS/iOS) o la pestaña de chat de la UI de Control.
3. Asegúrese de que la autenticación del Gateway esté configurada (requerida de forma predeterminada, incluso en loopback).

## Cómo funciona (comportamiento)

- La UI se conecta al WebSocket del Gateway y usa `chat.history`, `chat.send` y `chat.inject`.
- `chat.inject` agrega una nota del asistente directamente a la transcripción y la difunde a la UI (sin ejecución de agente).
- El historial siempre se obtiene del Gateway (sin observación de archivos locales).
- Si el Gateway no es accesible, WebChat es de solo lectura.

## Uso remoto

- El modo remoto tuneliza el WebSocket del Gateway sobre SSH/Tailscale.
- No necesita ejecutar un servidor de WebChat separado.

## Referencia de configuración (WebChat)

Configuración completa: [Configuration](/gateway/configuration)

Opciones del canal:

- No hay un bloque dedicado `webchat.*`. WebChat usa el endpoint del Gateway + la configuración de autenticación a continuación.

Opciones globales relacionadas:

- `gateway.port`, `gateway.bind`: host/puerto de WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: autenticación de WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: destino del Gateway remoto.
- `session.*`: almacenamiento de sesiones y valores predeterminados de la clave principal.
