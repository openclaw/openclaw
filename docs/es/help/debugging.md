---
summary: "Herramientas de depuración: modo de observación, flujos de modelo en bruto y trazado de fugas de razonamiento"
read_when:
  - Necesita inspeccionar la salida en bruto del modelo para detectar fugas de razonamiento
  - Quiere ejecutar el Gateway en modo de observación mientras itera
  - Necesita un flujo de trabajo de depuración repetible
title: "Depuración"
---

# Depuración

Esta página cubre ayudas de depuración para la salida en streaming, especialmente cuando un
proveedor mezcla razonamiento dentro del texto normal.

## Anulaciones de depuración de tiempo

Use `/debug` en el chat para establecer anulaciones de configuración **solo en tiempo de ejecución** (memoria, no disco).
`/debug` está deshabilitado de forma predeterminada; actívelo con `commands.debug: true`.
Esto es útil cuando necesita alternar configuraciones poco comunes sin editar `openclaw.json`.

Ejemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` borra todas las anulaciones y vuelve a la configuración en disco.

## Modo de observación del Gateway

Para una iteración rápida, ejecute el gateway bajo el observador de archivos:

```bash
pnpm gateway:watch --force
```

Esto se asigna a:

```bash
tsx watch src/entry.ts gateway --force
```

Agregue cualquier bandera de la CLI del gateway después de `gateway:watch` y se pasarán
en cada reinicio.

## Perfil de desarrollo + gateway de desarrollo (--dev)

Use el perfil de desarrollo para aislar el estado y levantar una configuración segura y desechable para
depuración. Hay **dos** banderas `--dev`:

- **Global `--dev` (perfil):** aísla el estado bajo `~/.openclaw-dev` y
  establece de forma predeterminada el puerto del gateway en `19001` (los puertos derivados se ajustan con él).
- **`gateway --dev`: indica al Gateway que cree automáticamente una configuración predeterminada +
  espacio de trabajo** cuando falten (y omite BOOTSTRAP.md).

Flujo recomendado (perfil de desarrollo + bootstrap de desarrollo):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Si aún no tiene una instalación global, ejecute la CLI mediante `pnpm openclaw ...`.

Qué hace esto:

1. **Aislamiento del perfil** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (el navegador/canvas se ajusta en consecuencia)

2. **Bootstrap de desarrollo** (`gateway --dev`)
   - Escribe una configuración mínima si falta (`gateway.mode=local`, enlaza a loopback).
   - Establece `agent.workspace` al espacio de trabajo de desarrollo.
   - Establece `agent.skipBootstrap=true` (sin BOOTSTRAP.md).
   - Inicializa los archivos del espacio de trabajo si faltan:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Identidad predeterminada: **C3‑PO** (droide de protocolo).
   - Omite los proveedores de canal en modo de desarrollo (`OPENCLAW_SKIP_CHANNELS=1`).

Flujo de restablecimiento (inicio limpio):

```bash
pnpm gateway:dev:reset
```

Nota: `--dev` es una bandera de perfil **global** y algunos ejecutores se la tragan.
Si necesita especificarla explícitamente, use la forma de variable de entorno:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` borra la configuración, las credenciales, las sesiones y el espacio de trabajo de desarrollo (usando
`trash`, no `rm`), y luego recrea la configuración de desarrollo predeterminada.

Consejo: si ya hay un gateway que no es de desarrollo en ejecución (launchd/systemd), deténgalo primero:

```bash
openclaw gateway stop
```

## Registro de flujos en bruto (OpenClaw)

OpenClaw puede registrar el **flujo del asistente en bruto** antes de cualquier filtrado/formateo.
Esta es la mejor manera de ver si el razonamiento llega como deltas de texto plano
(o como bloques de pensamiento separados).

Habilítelo mediante la CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Anulación opcional de la ruta:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Variables de env equivalentes:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Archivo predeterminado:

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

Archivo predeterminado:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Nota: esto solo lo emiten los procesos que usan el proveedor
> `openai-completions` de pi-mono.

## Notas de seguridad

- Los registros de flujos en bruto pueden incluir prompts completos, salida de herramientas y datos de usuario.
- Mantenga los registros locales y elimínelos después de depurar.
- Si comparte registros, elimine secretos y PII primero.
