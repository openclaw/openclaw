---
summary: "Cómo la app de mac integra el WebChat del Gateway y cómo depurarlo"
read_when:
  - Depuración de la vista WebChat de mac o del puerto de loopback
title: "WebChat"
---

# WebChat (app de macOS)

La app de la barra de menús de macOS integra la UI de WebChat como una vista nativa de SwiftUI. Se
conecta al Gateway y, de forma predeterminada, usa la **sesión principal** para el
agente seleccionado (con un selector de sesiones para otras sesiones).

- **Modo local**: se conecta directamente al WebSocket del Gateway local.
- **Modo remoto**: reenvía el puerto de control del Gateway por SSH y usa ese
  túnel como plano de datos.

## Iniciar y depurar

- Manual: menú Lobster → “Open Chat”.

- Apertura automática para pruebas:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Registros: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`).

## Cómo está conectado

- Plano de datos: métodos WS del Gateway `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` y eventos `chat`, `agent`, `presence`, `tick`, `health`.
- Sesión: por defecto, la sesión primaria (`main`, o `global` cuando el alcance es
  global). La UI puede cambiar entre sesiones.
- El onboarding usa una sesión dedicada para mantener separada la configuración del primer uso.

## Superficie de seguridad

- El modo remoto reenvía únicamente el puerto de control del WebSocket del Gateway por SSH.

## Limitaciones conocidas

- La UI está optimizada para sesiones de chat (no es un sandbox de navegador completo).
