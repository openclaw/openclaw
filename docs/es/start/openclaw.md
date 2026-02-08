---
summary: "Guía integral de extremo a extremo para ejecutar OpenClaw como asistente personal con advertencias de seguridad"
read_when:
  - Incorporar una nueva instancia de asistente
  - Revisar implicaciones de seguridad/permisos
title: "Configuración del asistente personal"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:45Z
---

# Creación de un asistente personal con OpenClaw

OpenClaw es un gateway de WhatsApp + Telegram + Discord + iMessage para agentes **Pi**. Los plugins agregan Mattermost. Esta guía es la configuración de “asistente personal”: un número de WhatsApp dedicado que se comporta como su agente siempre activo.

## ⚠️ Seguridad ante todo

Está poniendo a un agente en posición de:

- ejecutar comandos en su máquina (según su configuración de herramientas de Pi)
- leer/escribir archivos en su espacio de trabajo
- enviar mensajes hacia afuera vía WhatsApp/Telegram/Discord/Mattermost (plugin)

Empiece de forma conservadora:

- Establezca siempre `channels.whatsapp.allowFrom` (nunca ejecute abierto al mundo en su Mac personal).
- Use un número de WhatsApp dedicado para el asistente.
- Los heartbeats ahora tienen un valor predeterminado de cada 30 minutos. Desactívelos hasta confiar en la configuración estableciendo `agents.defaults.heartbeat.every: "0m"`.

## Requisitos previos

- OpenClaw instalado e incorporado — vea [Primeros pasos](/start/getting-started) si aún no lo ha hecho
- Un segundo número de teléfono (SIM/eSIM/prepago) para el asistente

## La configuración de dos teléfonos (recomendada)

Quiere esto:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Si vincula su WhatsApp personal a OpenClaw, cada mensaje hacia usted se convierte en “entrada del agente”. Eso rara vez es lo que quiere.

## Inicio rápido de 5 minutos

1. Empareje WhatsApp Web (muestra un QR; escanéelo con el teléfono del asistente):

```bash
openclaw channels login
```

2. Inicie el Gateway (déjelo en ejecución):

```bash
openclaw gateway --port 18789
```

3. Coloque una configuración mínima en `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Ahora envíe un mensaje al número del asistente desde su teléfono en la lista de permitidos.

Cuando finaliza la incorporación, abrimos automáticamente el panel y mostramos un enlace limpio (sin tokenizar). Si solicita autenticación, pegue el token de `gateway.auth.token` en la configuración de Control UI. Para reabrir más tarde: `openclaw dashboard`.

## Darle al agente un espacio de trabajo (AGENTS)

OpenClaw lee las instrucciones operativas y la “memoria” desde su directorio de espacio de trabajo.

De forma predeterminada, OpenClaw usa `~/.openclaw/workspace` como espacio de trabajo del agente y lo creará (más los archivos iniciales `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automáticamente durante la configuración o la primera ejecución del agente. `BOOTSTRAP.md` solo se crea cuando el espacio de trabajo es completamente nuevo (no debería volver a aparecer después de eliminarlo). `MEMORY.md` es opcional (no se crea automáticamente); cuando está presente, se carga para sesiones normales. Las sesiones de subagentes solo inyectan `AGENTS.md` y `TOOLS.md`.

Consejo: trate esta carpeta como la “memoria” de OpenClaw y conviértala en un repositorio git (idealmente privado) para que sus `AGENTS.md` + archivos de memoria tengan respaldo. Si git está instalado, los espacios de trabajo completamente nuevos se inicializan automáticamente.

```bash
openclaw setup
```

Diseño completo del espacio de trabajo + guía de respaldo: [Espacio de trabajo del agente](/concepts/agent-workspace)  
Flujo de trabajo de memoria: [Memoria](/concepts/memory)

Opcional: elija un espacio de trabajo diferente con `agents.defaults.workspace` (admite `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Si ya distribuye sus propios archivos de espacio de trabajo desde un repositorio, puede desactivar por completo la creación de archivos de arranque:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## La configuración que lo convierte en “un asistente”

OpenClaw tiene valores predeterminados adecuados para un asistente, pero normalmente querrá ajustar:

- la persona/instrucciones en `SOUL.md`
- valores predeterminados de razonamiento (si lo desea)
- heartbeats (una vez que confíe en él)

Ejemplo:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sesiones y memoria

- Archivos de sesión: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Metadatos de sesión (uso de tokens, última ruta, etc.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legado: `~/.openclaw/sessions/sessions.json`)
- `/new` o `/reset` inicia una sesión nueva para ese chat (configurable mediante `resetTriggers`). Si se envía solo, el agente responde con un saludo breve para confirmar el reinicio.
- `/compact [instructions]` compacta el contexto de la sesión e informa el presupuesto de contexto restante.

## Heartbeats (modo proactivo)

De forma predeterminada, OpenClaw ejecuta un heartbeat cada 30 minutos con el prompt:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Establezca `agents.defaults.heartbeat.every: "0m"` para desactivar.

- Si `HEARTBEAT.md` existe pero está efectivamente vacío (solo líneas en blanco y encabezados markdown como `# Heading`), OpenClaw omite la ejecución del heartbeat para ahorrar llamadas a la API.
- Si el archivo falta, el heartbeat se ejecuta y el modelo decide qué hacer.
- Si el agente responde con `HEARTBEAT_OK` (opcionalmente con relleno corto; vea `agents.defaults.heartbeat.ackMaxChars`), OpenClaw suprime la entrega saliente para ese heartbeat.
- Los heartbeats ejecutan turnos completos del agente — intervalos más cortos consumen más tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Medios de entrada y salida

Los adjuntos entrantes (imágenes/audio/documentos) pueden exponerse a su comando mediante plantillas:

- `{{MediaPath}}` (ruta de archivo temporal local)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (si la transcripción de audio está habilitada)

Adjuntos salientes del agente: incluya `MEDIA:<path-or-url>` en su propia línea (sin espacios). Ejemplo:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw los extrae y los envía como medios junto con el texto.

## Lista de verificación operativa

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Los registros se encuentran en `/tmp/openclaw/` (predeterminado: `openclaw-YYYY-MM-DD.log`).

## Siguientes pasos

- WebChat: [WebChat](/web/webchat)
- Operaciones del Gateway: [Runbook del Gateway](/gateway)
- Cron + activaciones: [Trabajos Cron](/automation/cron-jobs)
- Aplicación complementaria de la barra de menús de macOS: [OpenClaw macOS app](/platforms/macos)
- App de nodo para iOS: [iOS app](/platforms/ios)
- App de nodo para Android: [Android app](/platforms/android)
- Estado de Windows: [Windows (WSL2)](/platforms/windows)
- Estado de Linux: [Linux app](/platforms/linux)
- Seguridad: [Security](/gateway/security)
