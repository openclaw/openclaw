---
summary: "Host estático de WebChat en loopback y uso del WS del Gateway para interfaz de chat"
read_when:
  - Estás depurando o configurando el acceso a WebChat
title: "WebChat"
---

# WebChat (Interfaz WebSocket del Gateway)

Estado: la interfaz de chat SwiftUI de macOS/iOS habla directamente con el WebSocket del Gateway.

## Qué es

- Una interfaz de chat nativa para el gateway (sin navegador embebido y sin servidor estático local).
- Usa las mismas sesiones y reglas de enrutamiento que otros canales.
- Enrutamiento determinístico: las respuestas siempre vuelven a WebChat.

## Inicio rápido

1. Inicia el gateway.
2. Abre la interfaz de WebChat (aplicación macOS/iOS) o la pestaña de chat de la Interfaz de Control.
3. Asegúrate de que la autenticación del gateway esté configurada (requerida por defecto, incluso en loopback).

## Cómo funciona (comportamiento)

- La interfaz se conecta al WebSocket del Gateway y usa `chat.history`, `chat.send` y `chat.inject`.
- `chat.inject` agrega una nota del asistente directamente a la transcripción y la transmite a la interfaz (sin ejecución de agente).
- Las ejecuciones abortadas pueden mantener visible la salida parcial del asistente en la interfaz.
- El Gateway persiste el texto parcial del asistente abortado en el historial de transcripción cuando existe salida almacenada en búfer, y marca esas entradas con metadatos de aborto.
- El historial siempre se obtiene del gateway (sin observación de archivos locales).
- Si el gateway no es accesible, WebChat es de solo lectura.

## Uso remoto

- El modo remoto tuneliza el WebSocket del gateway sobre SSH/Tailscale.
- No necesitas ejecutar un servidor WebChat separado.

## Referencia de configuración (WebChat)

Configuración completa: [Configuración](/es-ES/gateway/configuration)

Opciones de canal:

- Sin bloque dedicado `webchat.*`. WebChat usa el endpoint del gateway + configuración de autenticación a continuación.

Opciones globales relacionadas:

- `gateway.port`, `gateway.bind`: host/puerto del WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: autenticación del WebSocket (token/contraseña).
- `gateway.auth.mode: "trusted-proxy"`: autenticación de proxy inverso para clientes del navegador (consulta [Autenticación de Proxy de Confianza](/es-ES/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: destino del gateway remoto.
- `session.*`: almacenamiento de sesión y valores predeterminados de clave principal.
