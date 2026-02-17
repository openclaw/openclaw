---
summary: "Autenticación de modelos: OAuth, claves API y setup-token"
read_when:
  - Debugging de autenticación de modelos o expiración de OAuth
  - Documentación de autenticación o almacenamiento de credenciales
title: "Autenticación"
---

# Autenticación

OpenClaw soporta OAuth y claves API para proveedores de modelos. Para cuentas de Anthropic, recomendamos usar una **clave API**. Para acceso con suscripción Claude, usa el token de larga duración creado por `claude setup-token`.

Consulta [/concepts/oauth](/es-ES/concepts/oauth) para el flujo completo de OAuth y el diseño de almacenamiento.

## Configuración recomendada de Anthropic (clave API)

Si estás usando Anthropic directamente, usa una clave API.

1. Crea una clave API en la Consola de Anthropic.
2. Ponla en el **host del gateway** (la máquina que ejecuta `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Si el Gateway se ejecuta bajo systemd/launchd, es preferible poner la clave en
   `~/.openclaw/.env` para que el daemon pueda leerla:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Luego reinicia el daemon (o reinicia tu proceso Gateway) y verifica de nuevo:

```bash
openclaw models status
openclaw doctor
```

Si prefieres no gestionar variables de entorno tú mismo, el asistente de onboarding puede almacenar
claves API para uso del daemon: `openclaw onboard`.

Consulta [Help](/es-ES/help) para detalles sobre herencia de env (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (autenticación de suscripción)

Para Anthropic, la ruta recomendada es una **clave API**. Si estás usando una suscripción Claude, el flujo setup-token también está soportado. Ejecútalo en el **host del gateway**:

```bash
claude setup-token
```

Luego pégalo en OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Si el token fue creado en otra máquina, pégalo manualmente:

```bash
openclaw models auth paste-token --provider anthropic
```

Si ves un error de Anthropic como:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…usa una clave API de Anthropic en su lugar.

Entrada manual de token (cualquier proveedor; escribe `auth-profiles.json` + actualiza config):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Verificación amigable para automatización (sale con `1` cuando está expirado/faltante, `2` cuando está expirando):

```bash
openclaw models status --check
```

Scripts de operaciones opcionales (systemd/Termux) están documentados aquí:
[/automation/auth-monitoring](/es-ES/automation/auth-monitoring)

> `claude setup-token` requiere un TTY interactivo.

## Verificando el estado de autenticación del modelo

```bash
openclaw models status
openclaw doctor
```

## Controlando qué credencial se usa

### Por sesión (comando chat)

Usa `/model <alias-or-id>@<profileId>` para fijar una credencial de proveedor específica para la sesión actual (ejemplo de IDs de perfil: `anthropic:default`, `anthropic:work`).

Usa `/model` (o `/model list`) para un selector compacto; usa `/model status` para la vista completa (candidatos + próximo perfil de auth, más detalles de endpoint del proveedor cuando esté configurado).

### Por agente (override CLI)

Establece un override de orden de perfil de auth explícito para un agente (almacenado en el `auth-profiles.json` de ese agente):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Usa `--agent <id>` para apuntar a un agente específico; omítelo para usar el agente predeterminado configurado.

## Solución de Problemas

### "No credentials found"

Si el perfil de token de Anthropic falta, ejecuta `claude setup-token` en el
**host del gateway**, luego verifica de nuevo:

```bash
openclaw models status
```

### Token expirando/expirado

Ejecuta `openclaw models status` para confirmar qué perfil está expirando. Si el perfil
falta, ejecuta de nuevo `claude setup-token` y pega el token otra vez.

## Requisitos

- Suscripción Claude Max o Pro (para `claude setup-token`)
- CLI de Claude Code instalado (comando `claude` disponible)
