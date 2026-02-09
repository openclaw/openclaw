---
summary: "Use Anthropic Claude mediante claves de API o setup-token en OpenClaw"
read_when:
  - Quiere usar modelos de Anthropic en OpenClaw
  - Quiere usar setup-token en lugar de claves de API
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic desarrolla la familia de modelos **Claude** y proporciona acceso mediante una API.
En OpenClaw puede autenticarse con una clave de API o con un **setup-token**.

## Opción A: Clave de API de Anthropic

**Mejor para:** acceso estándar a la API y facturación por uso.
Cree su clave de API en la Consola de Anthropic.

### Configuración de la CLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
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

Use el parámetro `cacheRetention` en la configuración de su modelo:

| Valor   | Duración de caché | Descripción                                                |
| ------- | ----------------- | ---------------------------------------------------------- |
| `none`  | Sin caché         | Desactivar la caché de prompts                             |
| `short` | 5 minutos         | Valor predeterminado para auth con clave de API            |
| `long`  | 1 hora            | Caché extendida (requiere bandera beta) |

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

### Valores predeterminados

Al usar autenticación con clave de API de Anthropic, OpenClaw aplica automáticamente `cacheRetention: "short"` (caché de 5 minutos) para todos los modelos de Anthropic. Puede sobrescribirlo configurando explícitamente `cacheRetention` en su configuración.

### Parámetro heredado

El parámetro anterior `cacheControlTtl` aún es compatible por compatibilidad retroactiva:

- `"5m"` se asigna a `short`
- `"1h"` se asigna a `long`

Recomendamos migrar al nuevo parámetro `cacheRetention`.

OpenClaw incluye la bandera beta `extended-cache-ttl-2025-04-11` para solicitudes de la API de Anthropic; consérvela si sobrescribe los encabezados del proveedor (consulte [/gateway/configuration](/gateway/configuration)).

## Opción B: Claude setup-token

**Mejor para:** usar su suscripción de Claude.

### Dónde obtener un setup-token

Los setup-tokens se crean con la **Claude Code CLI**, no en la Consola de Anthropic. Puede ejecutarla en **cualquier máquina**:

```bash
claude setup-token
```

Pegue el token en OpenClaw (asistente: **Anthropic token (pegar setup-token)**), o ejecútelo en el host del Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Si generó el token en otra máquina, péguelo:

```bash
openclaw models auth paste-token --provider anthropic
```

### Configuración de la CLI (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Fragmento de configuración (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notas

- Genere el setup-token con `claude setup-token` y péguelo, o ejecute `openclaw models auth setup-token` en el host del Gateway.
- Si ve “OAuth token refresh failed …” en una suscripción de Claude, vuelva a autenticarse con un setup-token. Consulte [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Los detalles de autenticación y las reglas de reutilización están en [/concepts/oauth](/concepts/oauth).

## Solución de problemas

**Errores 401 / token inválido de repente**

- La autenticación de suscripción de Claude puede expirar o revocarse. Vuelva a ejecutar `claude setup-token`
  y péguelo en el **host del Gateway**.
- Si el inicio de sesión de la CLI de Claude está en otra máquina, use
  `openclaw models auth paste-token --provider anthropic` en el host del Gateway.

**No se encontró una clave de API para el proveedor "anthropic"**

- La autenticación es **por agente**. Los agentes nuevos no heredan las claves del agente principal.
- Vuelva a ejecutar el onboarding para ese agente, o pegue un setup-token / clave de API en el
  host del Gateway y luego verifique con `openclaw models status`.

**No se encontraron credenciales para el perfil `anthropic:default`**

- Ejecute `openclaw models status` para ver qué perfil de autenticación está activo.
- Vuelva a ejecutar el onboarding, o pegue un setup-token / clave de API para ese perfil.

**No hay un perfil de autenticación disponible (todos en enfriamiento/no disponibles)**

- Revise `openclaw models status --json` para `auth.unusableProfiles`.
- Agregue otro perfil de Anthropic o espere a que termine el enfriamiento.

Más: [/gateway/troubleshooting](/gateway/troubleshooting) y [/help/faq](/help/faq).
