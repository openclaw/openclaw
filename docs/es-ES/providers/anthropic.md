---
summary: "Usa Anthropic Claude mediante claves de API o setup-token en OpenClaw"
read_when:
  - Quieres usar modelos de Anthropic en OpenClaw
  - Quieres usar setup-token en lugar de claves de API
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic desarrolla la familia de modelos **Claude** y proporciona acceso mediante una API.
En OpenClaw puedes autenticarte con una clave de API o un **setup-token**.

## Opción A: Clave de API de Anthropic

**Mejor para:** acceso estándar a la API y facturación basada en uso.
Crea tu clave de API en la Consola de Anthropic.

### Configuración mediante CLI

```bash
openclaw onboard
# elige: Anthropic API key

# o no interactivo
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Fragmento de configuración

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Caché de prompts (API de Anthropic)

OpenClaw admite la función de caché de prompts de Anthropic. Esto es **solo para API**; la autenticación por suscripción no respeta la configuración de caché.

### Configuración

Usa el parámetro `cacheRetention` en la configuración de tu modelo:

| Valor   | Duración de caché | Descripción                               |
| ------- | ----------------- | ----------------------------------------- |
| `none`  | Sin caché         | Deshabilita el caché de prompts          |
| `short` | 5 minutos         | Por defecto para autenticación con clave de API |
| `long`  | 1 hora            | Caché extendida (requiere flag beta)     |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Valores por defecto

Al usar autenticación con clave de API de Anthropic, OpenClaw aplica automáticamente `cacheRetention: "short"` (caché de 5 minutos) para todos los modelos de Anthropic. Puedes anular esto estableciendo explícitamente `cacheRetention` en tu configuración.

### Parámetro legacy

El parámetro antiguo `cacheControlTtl` todavía se admite por compatibilidad hacia atrás:

- `"5m"` se mapea a `short`
- `"1h"` se mapea a `long`

Recomendamos migrar al nuevo parámetro `cacheRetention`.

OpenClaw incluye el flag beta `extended-cache-ttl-2025-04-11` para las solicitudes a la API de Anthropic; mantenlo si anulas los encabezados del proveedor (ver [/es-ES/gateway/configuration](/es-ES/gateway/configuration)).

## Opción B: Setup-token de Claude

**Mejor para:** usar tu suscripción de Claude.

### Dónde obtener un setup-token

Los setup-tokens son creados por el **CLI de Claude Code**, no por la Consola de Anthropic. Puedes ejecutar esto en **cualquier máquina**:

```bash
claude setup-token
```

Pega el token en OpenClaw (asistente: **Anthropic token (paste setup-token)**), o ejecútalo en el host del gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Si generaste el token en una máquina diferente, pégalo:

```bash
openclaw models auth paste-token --provider anthropic
```

### Configuración mediante CLI (setup-token)

```bash
# Pega un setup-token durante la incorporación
openclaw onboard --auth-choice setup-token
```

### Fragmento de configuración (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notas

- Genera el setup-token con `claude setup-token` y pégalo, o ejecuta `openclaw models auth setup-token` en el host del gateway.
- Si ves "OAuth token refresh failed …" en una suscripción de Claude, vuelve a autenticarte con un setup-token. Ver [/es-ES/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/es-ES/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Los detalles de autenticación y las reglas de reutilización están en [/es-ES/concepts/oauth](/es-ES/concepts/oauth).

## Solución de problemas

**Errores 401 / token repentinamente inválido**

- La autenticación por suscripción de Claude puede expirar o ser revocada. Vuelve a ejecutar `claude setup-token`
  y pégalo en el **host del gateway**.
- Si el login del CLI de Claude está en una máquina diferente, usa
  `openclaw models auth paste-token --provider anthropic` en el host del gateway.

**No se encontró clave de API para el proveedor "anthropic"**

- La autenticación es **por agente**. Los nuevos agentes no heredan las claves del agente principal.
- Vuelve a ejecutar la incorporación para ese agente, o pega un setup-token / clave de API en el
  host del gateway, luego verifica con `openclaw models status`.

**No se encontraron credenciales para el perfil `anthropic:default`**

- Ejecuta `openclaw models status` para ver qué perfil de autenticación está activo.
- Vuelve a ejecutar la incorporación, o pega un setup-token / clave de API para ese perfil.

**No hay perfil de autenticación disponible (todos en cooldown/no disponibles)**

- Consulta `openclaw models status --json` para `auth.unusableProfiles`.
- Agrega otro perfil de Anthropic o espera el cooldown.

Más: [/es-ES/gateway/troubleshooting](/es-ES/gateway/troubleshooting) y [/es-ES/help/faq](/es-ES/help/faq).
