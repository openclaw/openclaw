---
title: Sandbox vs Política de herramientas vs Elevado
summary: "Por qué una herramienta está bloqueada: runtime del sandbox, política de permitir/denegar herramientas y compuertas de ejecución elevada"
read_when: "Cuando aparece 'sandbox jail' o ve un rechazo de herramienta/elevado y quiere la clave de configuración exacta que debe cambiar."
status: active
---

# Sandbox vs Política de herramientas vs Elevado

OpenClaw tiene tres controles relacionados (pero diferentes):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decide **dónde se ejecutan las herramientas** (Docker vs host).
2. **Política de herramientas** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decide **qué herramientas están disponibles/permitidas**.
3. **Elevado** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) es una **vía de escape solo para exec** para ejecutar en el host cuando usted está en sandbox.

## Depuración rápida

Use el inspector para ver lo que OpenClaw está _realmente_ haciendo:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Imprime:

- modo/alcance/acceso al workspace efectivos del sandbox
- si la sesión está actualmente en sandbox (principal vs no principal)
- permitir/denegar efectivo de herramientas en sandbox (y si provino de agente/global/predeterminado)
- compuertas de elevado y rutas de claves para corregir

## Sandbox: dónde se ejecutan las herramientas

El sandboxing se controla con `agents.defaults.sandbox.mode`:

- `"off"`: todo se ejecuta en el host.
- `"non-main"`: solo las sesiones no principales están en sandbox (sorpresa común para grupos/canales).
- `"all"`: todo está en sandbox.

Vea [Sandboxing](/gateway/sandboxing) para la matriz completa (alcance, montajes del workspace, imágenes).

### Bind mounts (verificación rápida de seguridad)

- `docker.binds` _atraviesa_ el sistema de archivos del sandbox: lo que usted monte es visible dentro del contenedor con el modo que establezca (`:ro` o `:rw`).
- El valor predeterminado es lectura-escritura si omite el modo; prefiera `:ro` para código fuente/secretos.
- `scope: "shared"` ignora los binds por agente (solo aplican los binds globales).
- Vincular `/var/run/docker.sock` efectivamente entrega el control del host al sandbox; hágalo solo de forma intencional.
- El acceso al workspace (`workspaceAccess: "ro"`/`"rw"`) es independiente de los modos de bind.

## Política de herramientas: qué herramientas existen/son invocables

Dos capas importan:

- **Perfil de herramientas**: `tools.profile` y `agents.list[].tools.profile` (lista de permitidos base)
- **Perfil de herramientas del proveedor**: `tools.byProvider[provider].profile` y `agents.list[].tools.byProvider[provider].profile`
- **Política de herramientas global/por agente**: `tools.allow`/`tools.deny` y `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Política de herramientas del proveedor**: `tools.byProvider[provider].allow/deny` y `agents.list[].tools.byProvider[provider].allow/deny`
- **Política de herramientas del sandbox** (solo aplica cuando está en sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` y `agents.list[].tools.sandbox.tools.*`

Reglas prácticas:

- `deny` siempre gana.
- Si `allow` no está vacío, todo lo demás se trata como bloqueado.
- La política de herramientas es el tope duro: `/exec` no puede anular una herramienta `exec` denegada.
- `/exec` solo cambia los valores predeterminados de la sesión para remitentes autorizados; no otorga acceso a herramientas.
  Las claves de herramientas del proveedor aceptan `provider` (p. ej., `google-antigravity`) o `provider/model` (p. ej., `openai/gpt-5.2`).

### Grupos de herramientas (atajos)

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

## Elevado: “ejecutar en el host” solo para exec

Elevado **no** otorga herramientas adicionales; solo afecta a `exec`.

- Si usted está en sandbox, `/elevated on` (o `exec` con `elevated: true`) se ejecuta en el host (pueden seguir aplicando aprobaciones).
- Use `/elevated full` para omitir aprobaciones de exec para la sesión.
- Si ya está ejecutando directo, elevado es efectivamente un no-op (sigue estando controlado).
- Elevado **no** está acotado por skill y **no** anula permitir/denegar de herramientas.
- `/exec` es independiente de elevado. Solo ajusta los valores predeterminados de exec por sesión para remitentes autorizados.

Puertas:

- Habilitación: `tools.elevated.enabled` (y opcionalmente `agents.list[].tools.elevated.enabled`)
- Listas de permitidos de remitentes: `tools.elevated.allowFrom.<provider>` (y opcionalmente `agents.list[].tools.elevated.allowFrom.<provider>`)

Vea [Modo Elevado](/tools/elevated).

## Correcciones comunes de “sandbox jail”

### “La herramienta X está bloqueada por la política de herramientas del sandbox”

Claves para corregir (elija una):

- Deshabilitar sandbox: `agents.defaults.sandbox.mode=off` (o por agente `agents.list[].sandbox.mode=off`)
- Permitir la herramienta dentro del sandbox:
  - eliminarla de `tools.sandbox.tools.deny` (o por agente `agents.list[].tools.sandbox.tools.deny`)
  - o agregarla a `tools.sandbox.tools.allow` (o permitir por agente)

### “Pensé que esto era principal, ¿por qué está en sandbox?”

En el modo `"non-main"`, las claves de grupo/canal _no_ son principales. Use la clave de sesión principal (mostrada por `sandbox explain`) o cambie el modo a `"off"`.
