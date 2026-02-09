---
summary: "Autenticación de modelos: OAuth, claves de API y token de configuración"
read_when:
  - Depuración de autenticación de modelos o expiración de OAuth
  - Documentación de autenticación o almacenamiento de credenciales
title: "Autenticación"
---

# Autenticación

OpenClaw admite OAuth y claves de API para proveedores de modelos. Para cuentas de Anthropic, recomendamos usar una **clave de API**. Para el acceso por suscripción de Claude, use el token de larga duración creado por `claude setup-token`.

Consulte [/concepts/oauth](/concepts/oauth) para ver el flujo completo de OAuth y el diseño de almacenamiento.

## Configuración recomendada de Anthropic (clave de API)

Si utiliza Anthropic directamente, use una clave de API.

1. Cree una clave de API en la Consola de Anthropic.
2. Colóquela en el **host del Gateway** (la máquina que ejecuta `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Si el Gateway se ejecuta bajo systemd/launchd, prefiera poner la clave en
   `~/.openclaw/.env` para que el daemon pueda leerla:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Luego reinicie el daemon (o reinicie su proceso del Gateway) y vuelva a comprobar:

```bash
openclaw models status
openclaw doctor
```

Si prefiere no gestionar variables de entorno por su cuenta, el asistente de incorporación puede almacenar claves de API para uso del daemon: `openclaw onboard`.

Consulte [Help](/help) para obtener detalles sobre la herencia de variables de entorno (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: token de configuración (autenticación por suscripción)

Para Anthropic, la ruta recomendada es una **clave de API**. Si utiliza una suscripción de Claude, también se admite el flujo de token de configuración. Ejecútelo en el **host del Gateway**:

```bash
claude setup-token
```

Luego péguelo en OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Si el token se creó en otra máquina, péguelo manualmente:

```bash
openclaw models auth paste-token --provider anthropic
```

Si ve un error de Anthropic como:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…use una clave de API de Anthropic en su lugar.

Entrada manual de token (cualquier proveedor; escribe `auth-profiles.json` + actualiza la configuración):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Comprobación apta para automatización (sale con `1` cuando está expirado/falta, `2` cuando está por expirar):

```bash
openclaw models status --check
```

Los scripts opcionales de operaciones (systemd/Termux) se documentan aquí:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` requiere un TTY interactivo.

## Comprobación del estado de autenticación del modelo

```bash
openclaw models status
openclaw doctor
```

## Controlar qué credencial se utiliza

### Por sesión (comando de chat)

Use `/model <alias-or-id>@<profileId>` para fijar una credencial de proveedor específica para la sesión actual (ids de perfil de ejemplo: `anthropic:default`, `anthropic:work`).

Use `/model` (o `/model list`) para un selector compacto; use `/model status` para la vista completa (candidatos + siguiente perfil de autenticación, además de detalles del endpoint del proveedor cuando esté configurado).

### Por agente (anulación en la CLI)

Establezca una anulación explícita del orden de perfiles de autenticación para un agente (se almacena en el `auth-profiles.json` de ese agente):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Use `--agent <id>` para apuntar a un agente específico; omítalo para usar el agente predeterminado configurado.

## Solución de problemas

### “No se encontraron credenciales”

Si falta el perfil de token de Anthropic, ejecute `claude setup-token` en el
**host del Gateway**, luego vuelva a comprobar:

```bash
openclaw models status
```

### Token por expirar/expirado

Ejecute `openclaw models status` para confirmar qué perfil está por expirar. Si el perfil
falta, vuelva a ejecutar `claude setup-token` y pegue el token nuevamente.

## Requisitos

- Suscripción Claude Max o Pro (para `claude setup-token`)
- Claude Code CLI instalada (comando `claude` disponible)
