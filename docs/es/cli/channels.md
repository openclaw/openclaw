---
summary: "Referencia de la CLI para `openclaw channels` (cuentas, estado, inicio/cierre de sesión, registros)"
read_when:
  - Desea agregar/eliminar cuentas de canales (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Desea comprobar el estado del canal o seguir los registros del canal
title: "channels"
---

# `openclaw channels`

Administre las cuentas de canales de chat y su estado de ejecución en el Gateway.

Documentación relacionada:

- Guías de canales: [Channels](/channels/index)
- Configuración del Gateway: [Configuration](/gateway/configuration)

## Comandos comunes

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Agregar / eliminar cuentas

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Consejo: `openclaw channels add --help` muestra las banderas específicas por canal (token, app token, rutas de signal-cli, etc.).

## Inicio / cierre de sesión (interactivo)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Solución de problemas

- Ejecute `openclaw status --deep` para una prueba amplia.
- Use `openclaw doctor` para correcciones guiadas.
- `openclaw channels list` imprime `Claude: HTTP 403 ... user:profile` → la instantánea de uso necesita el alcance `user:profile`. Use `--no-usage`, o proporcione una clave de sesión de claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), o vuelva a autenticarse mediante Claude Code CLI.

## Sondeo de capacidades

Obtenga sugerencias de capacidades del proveedor (intents/alcances cuando estén disponibles) además del soporte de características estáticas:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notas:

- `--channel` es opcional; omítalo para listar todos los canales (incluidas las extensiones).
- `--target` acepta `channel:<id>` o un id numérico de canal sin procesar y solo aplica a Discord.
- Los sondeos son específicos del proveedor: intents de Discord + permisos de canal opcionales; alcances de bot + usuario de Slack; banderas de bot de Telegram + webhook; versión del daemon de Signal; token de la app de MS Teams + roles/alcances de Graph (anotados cuando se conocen). Los canales sin sondeos informan `Probe: unavailable`.

## Resolver nombres a IDs

Resuelva nombres de canales/usuarios a IDs usando el directorio del proveedor:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notas:

- Use `--kind user|group|auto` para forzar el tipo de destino.
- La resolución prefiere coincidencias activas cuando varias entradas comparten el mismo nombre.
