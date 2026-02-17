---
summary: "Runtime del Gateway en macOS (servicio launchd externo)"
read_when:
  - Empaquetando OpenClaw.app
  - Depurando el servicio launchd del gateway en macOS
  - Instalando el CLI del gateway para macOS
title: "Gateway en macOS"
---

# Gateway en macOS (launchd externo)

OpenClaw.app ya no incluye Node/Bun ni el runtime del Gateway. La aplicación macOS
espera una instalación CLI externa de `openclaw`, no genera el Gateway como un
proceso hijo, y gestiona un servicio launchd por usuario para mantener el Gateway
ejecutándose (o se conecta a un Gateway local existente si ya está ejecutándose).

## Instalar el CLI (requerido para modo local)

Necesitas Node 22+ en la Mac, luego instala `openclaw` globalmente:

```bash
npm install -g openclaw@<version>
```

El botón **Instalar CLI** de la aplicación macOS ejecuta el mismo flujo vía npm/pnpm (bun no recomendado para el runtime del Gateway).

## Launchd (Gateway como LaunchAgent)

Etiqueta:

- `bot.molt.gateway` (o `bot.molt.<profile>`; el legado `com.openclaw.*` puede permanecer)

Ubicación del plist (por usuario):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (o `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Gestor:

- La aplicación macOS posee la instalación/actualización de LaunchAgent en modo Local.
- El CLI también puede instalarlo: `openclaw gateway install`.

Comportamiento:

- "OpenClaw Activo" habilita/deshabilita el LaunchAgent.
- Salir de la aplicación **no** detiene el gateway (launchd lo mantiene vivo).
- Si un Gateway ya está ejecutándose en el puerto configurado, la aplicación se conecta a
  él en lugar de iniciar uno nuevo.

Registro:

- stdout/err de launchd: `/tmp/openclaw/openclaw-gateway.log`

## Compatibilidad de versiones

La aplicación macOS verifica la versión del gateway contra su propia versión. Si son
incompatibles, actualiza el CLI global para que coincida con la versión de la aplicación.

## Verificación rápida

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
