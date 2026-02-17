---
summary: "Cómo la app de Mac incrusta el WebChat del gateway y cómo depurarlo"
read_when:
  - Depurando la vista de WebChat de Mac o puerto loopback
title: "WebChat"
---

# WebChat (app de macOS)

La app de barra de menú de macOS incrusta la UI de WebChat como una vista nativa de SwiftUI. Se conecta al Gateway y por defecto a la **sesión principal** para el agente seleccionado (con un selector de sesión para otras sesiones).

- **Modo local**: se conecta directamente al WebSocket del Gateway local.
- **Modo remoto**: reenvía el puerto de control del Gateway sobre SSH y usa ese túnel como plano de datos.

## Lanzamiento y depuración

- Manual: menú Lobster → "Open Chat".
- Auto‑apertura para testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsistema `bot.molt`, categoría `WebChatSwiftUI`).

## Cómo está conectado

- Plano de datos: métodos WS del Gateway `chat.history`, `chat.send`, `chat.abort`, `chat.inject` y eventos `chat`, `agent`, `presence`, `tick`, `health`.
- Sesión: por defecto a la sesión primaria (`main`, o `global` cuando el alcance es global). La UI puede cambiar entre sesiones.
- El onboarding usa una sesión dedicada para mantener la configuración de primera ejecución separada.

## Superficie de seguridad

- El modo remoto reenvía solo el puerto de control WebSocket del Gateway sobre SSH.

## Limitaciones conocidas

- La UI está optimizada para sesiones de chat (no un sandbox de navegador completo).
