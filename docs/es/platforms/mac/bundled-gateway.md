---
summary: "Tiempo de ejecución del Gateway en macOS (servicio launchd externo)"
read_when:
  - Empaquetar OpenClaw.app
  - Depurar el servicio launchd del Gateway en macOS
  - Instalar la CLI del Gateway para macOS
title: "Gateway en macOS"
---

# Gateway en macOS (launchd externo)

OpenClaw.app ya no incluye Node/Bun ni el tiempo de ejecución del Gateway. La app de macOS
espera una instalación **externa** de la CLI `openclaw`, no inicia el Gateway como un
proceso hijo y gestiona un servicio launchd por usuario para mantener el Gateway
en ejecución (o se conecta a un Gateway local existente si ya hay uno en ejecución).

## Instalar la CLI (obligatorio para el modo local)

Necesita Node 22+ en el Mac y luego instalar `openclaw` de forma global:

```bash
npm install -g openclaw@<version>
```

El botón **Install CLI** de la app de macOS ejecuta el mismo flujo mediante npm/pnpm (bun no se recomienda para el tiempo de ejecución del Gateway).

## Launchd (Gateway como LaunchAgent)

Etiqueta:

- `bot.molt.gateway` (o `bot.molt.<profile>`; el legado `com.openclaw.*` puede permanecer)

Ubicación del plist (por usuario):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (o `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Gestión:

- La app de macOS gestiona la instalación/actualización del LaunchAgent en modo Local.
- La CLI también puede instalarlo: `openclaw gateway install`.

Comportamiento:

- “OpenClaw Active” habilita/deshabilita el LaunchAgent.
- Al salir de la app **no** se detiene el gateway (launchd lo mantiene activo).
- Si ya hay un Gateway en ejecución en el puerto configurado, la app se conecta
  a él en lugar de iniciar uno nuevo.

Registro:

- stdout/err de launchd: `/tmp/openclaw/openclaw-gateway.log`

## Compatibilidad de versiones

La app de macOS verifica la versión del gateway frente a su propia versión. Si son
incompatibles, actualice la CLI global para que coincida con la versión de la app.

## Comprobación de humo

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Luego:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
