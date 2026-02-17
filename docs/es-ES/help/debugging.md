---
summary: "Herramientas de depuración: modo watch, flujos de modelo en bruto y rastreo de fugas de razonamiento"
read_when:
  - Necesitas inspeccionar la salida del modelo en bruto para fugas de razonamiento
  - Quieres ejecutar el Gateway en modo watch mientras iteras
  - Necesitas un flujo de trabajo de depuración repetible
title: "Depuración"
---

# Depuración

Esta página cubre ayudas de depuración para salida de streaming, especialmente cuando un
proveedor mezcla razonamiento en texto normal.

## Sobrescrituras de depuración en tiempo de ejecución

Usa `/debug` en el chat para establecer sobrescrituras de configuración **solo en tiempo de ejecución** (memoria, no disco).
`/debug` está deshabilitado por defecto; habilita con `commands.debug: true`.
Esto es útil cuando necesitas alternar configuraciones oscuras sin editar `openclaw.json`.

Ejemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` borra todas las sobrescrituras y regresa a la configuración en disco.

## Modo watch del Gateway

Para iteración rápida, ejecuta el gateway bajo el observador de archivos:

```bash
pnpm gateway:watch --force
```

Esto mapea a:

```bash
tsx watch src/entry.ts gateway --force
```

Agrega cualquier bandera CLI del gateway después de `gateway:watch` y se pasarán
en cada reinicio.

## Perfil dev + dev gateway (--dev)

Usa el perfil dev para aislar estado y crear una configuración segura y desechable para
depuración. Hay **dos** banderas `--dev`:

- **`--dev` global (perfil):** aísla estado bajo `~/.openclaw-dev` y
  establece por defecto el puerto del gateway a `19001` (los puertos derivados se desplazan con él).
- **`gateway --dev`: le dice al Gateway que cree automáticamente una configuración + workspace por defecto**
  cuando falten (y omita BOOTSTRAP.md).

Flujo recomendado (perfil dev + inicialización dev):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Si aún no tienes una instalación global, ejecuta el CLI vía `pnpm openclaw ...`.

Qué hace esto:

1. **Aislamiento de perfil** (`--dev` global)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (navegador/lienzo se desplazan en consecuencia)

2. **Inicialización dev** (`gateway --dev`)
   - Escribe una configuración mínima si falta (`gateway.mode=local`, bind loopback).
   - Establece `agent.workspace` al workspace dev.
   - Establece `agent.skipBootstrap=true` (sin BOOTSTRAP.md).
   - Siembra los archivos del workspace si faltan:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Identidad por defecto: **C3‑PO** (droide de protocolo).
   - Omite proveedores de canales en modo dev (`OPENCLAW_SKIP_CHANNELS=1`).

Flujo de reinicio (inicio fresco):

```bash
pnpm gateway:dev:reset
```

Nota: `--dev` es una bandera de perfil **global** y es consumida por algunos ejecutores.
Si necesitas especificarlo, usa la forma de variable de entorno:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` borra config, credenciales, sesiones y el workspace dev (usando
`trash`, no `rm`), luego recrea la configuración dev por defecto.

Consejo: si ya se está ejecutando un gateway no-dev (launchd/systemd), detenlo primero:

```bash
openclaw gateway stop
```

## Registro de flujo en bruto (OpenClaw)

OpenClaw puede registrar el **flujo de asistente en bruto** antes de cualquier filtrado/formato.
Esta es la mejor manera de ver si el razonamiento está llegando como deltas de texto plano
(o como bloques de pensamiento separados).

Habilitarlo vía CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Sobrescritura de ruta opcional:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Variables de entorno equivalentes:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Archivo por defecto:

`~/.openclaw/logs/raw-stream.jsonl`

## Registro de fragmentos en bruto (pi-mono)

Para capturar **fragmentos en bruto compatibles con OpenAI** antes de que se analicen en bloques,
pi-mono expone un registrador separado:

```bash
PI_RAW_STREAM=1
```

Ruta opcional:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Archivo por defecto:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Nota: esto solo se emite por procesos que usan el proveedor
> `openai-completions` de pi-mono.

## Notas de seguridad

- Los registros de flujo en bruto pueden incluir prompts completos, salida de herramientas y datos de usuario.
- Mantén los registros locales y elimínalos después de depurar.
- Si compartes registros, primero elimina secretos e información personal identificable.
