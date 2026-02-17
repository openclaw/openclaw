---
title: Sandbox vs Política de Herramientas vs Elevated
summary: "Por qué se bloquea una herramienta: runtime de sandbox, política de permitir/denegar herramientas y puertas de exec elevado"
read_when: "Encuentras 'cárcel de sandbox' o ves un rechazo de herramienta/elevado y quieres la clave de config exacta para cambiar."
status: active
---

# Sandbox vs Política de Herramientas vs Elevated

OpenClaw tiene tres controles relacionados (pero diferentes):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decide **dónde se ejecutan las herramientas** (Docker vs host).
2. **Política de herramientas** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decide **qué herramientas están disponibles/permitidas**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) es una **escotilla de escape solo para exec** para ejecutar en el host cuando estás en sandbox.

## Depuración rápida

Usa el inspector para ver qué está haciendo OpenClaw _realmente_:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Imprime:

- modo/alcance/acceso al espacio de trabajo de sandbox efectivo
- si la sesión está actualmente en sandbox (main vs no-main)
- permitir/denegar herramientas de sandbox efectivo (y si vino de agente/global/predeterminado)
- puertas elevadas y rutas de claves de corrección

## Sandbox: dónde se ejecutan las herramientas

El sandboxing se controla mediante `agents.defaults.sandbox.mode`:

- `"off"`: todo se ejecuta en el host.
- `"non-main"`: solo las sesiones no-main están en sandbox (común "sorpresa" para grupos/canales).
- `"all"`: todo está en sandbox.

Ver [Sandboxing](/es-ES/gateway/sandboxing) para la matriz completa (alcance, montajes de workspace, imágenes).

### Montajes bind (verificación rápida de seguridad)

- `docker.binds` _perfora_ el sistema de archivos del sandbox: lo que montes es visible dentro del contenedor con el modo que establezcas (`:ro` o `:rw`).
- El predeterminado es lectura-escritura si omites el modo; prefiere `:ro` para fuentes/secretos.
- `scope: "shared"` ignora los binds por agente (solo se aplican los binds globales).
- Montar `/var/run/docker.sock` efectivamente entrega el control del host al sandbox; solo haz esto intencionalmente.
- El acceso al espacio de trabajo (`workspaceAccess: "ro"`/`"rw"`) es independiente de los modos de bind.

## Política de herramientas: qué herramientas existen/son invocables

Importan dos capas:

- **Perfil de herramienta**: `tools.profile` y `agents.list[].tools.profile` (lista de permitidos base)
- **Perfil de herramienta del proveedor**: `tools.byProvider[provider].profile` y `agents.list[].tools.byProvider[provider].profile`
- **Política de herramientas global/por agente**: `tools.allow`/`tools.deny` y `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Política de herramientas del proveedor**: `tools.byProvider[provider].allow/deny` y `agents.list[].tools.byProvider[provider].allow/deny`
- **Política de herramientas de sandbox** (solo se aplica cuando está en sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` y `agents.list[].tools.sandbox.tools.*`

Reglas generales:

- `deny` siempre gana.
- Si `allow` no está vacío, todo lo demás se trata como bloqueado.
- La política de herramientas es la parada definitiva: `/exec` no puede anular una herramienta `exec` denegada.
- `/exec` solo cambia los valores predeterminados de sesión para remitentes autorizados; no otorga acceso a herramientas.
  Las claves de herramientas del proveedor aceptan `provider` (ej. `google-antigravity`) o `provider/model` (ej. `openai/gpt-5.2`).

### Grupos de herramientas (abreviaturas)

Las políticas de herramientas (global, agente, sandbox) admiten entradas `group:*` que se expanden a múltiples herramientas:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Grupos disponibles:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas las herramientas integradas de OpenClaw (excluye plugins de proveedores)

## Elevated: solo exec "ejecutar en host"

Elevated **no** otorga herramientas extra; solo afecta a `exec`.

- Si estás en sandbox, `/elevated on` (o `exec` con `elevated: true`) se ejecuta en el host (aún pueden aplicarse aprobaciones).
- Usa `/elevated full` para omitir aprobaciones de exec para la sesión.
- Si ya estás ejecutando directo, elevated es efectivamente un no-op (aún controlado).
- Elevated **no** está delimitado por habilidad y **no** anula permitir/denegar herramientas.
- `/exec` es separado de elevated. Solo ajusta los valores predeterminados de exec por sesión para remitentes autorizados.

Puertas:

- Habilitación: `tools.elevated.enabled` (y opcionalmente `agents.list[].tools.elevated.enabled`)
- Listas de permitidos de remitente: `tools.elevated.allowFrom.<provider>` (y opcionalmente `agents.list[].tools.elevated.allowFrom.<provider>`)

Ver [Modo Elevated](/es-ES/tools/elevated).

## Correcciones comunes de "cárcel de sandbox"

### "Herramienta X bloqueada por la política de herramientas de sandbox"

Claves de corrección (elige una):

- Deshabilita sandbox: `agents.defaults.sandbox.mode=off` (o por agente `agents.list[].sandbox.mode=off`)
- Permite la herramienta dentro del sandbox:
  - elimínala de `tools.sandbox.tools.deny` (o por agente `agents.list[].tools.sandbox.tools.deny`)
  - o agrégala a `tools.sandbox.tools.allow` (o permitir por agente)

### "Pensé que esto era main, ¿por qué está en sandbox?"

En modo `"non-main"`, las claves de grupo/canal _no_ son main. Usa la clave de sesión principal (mostrada por `sandbox explain`) o cambia el modo a `"off"`.
