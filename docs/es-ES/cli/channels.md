---
summary: "Referencia CLI para `openclaw channels` (cuentas, estado, login/logout, registros)"
read_when:
  - Quieres añadir/eliminar cuentas de canal (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Quieres verificar el estado del canal o rastrear registros del canal
title: "channels"
---

# `openclaw channels`

Gestionar cuentas de canal de chat y su estado de ejecución en el Gateway.

Documentos relacionados:

- Guías de canales: [Canales](/es-ES/channels/index)
- Configuración del Gateway: [Configuración](/es-ES/gateway/configuration)

## Comandos comunes

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Añadir / eliminar cuentas

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Consejo: `openclaw channels add --help` muestra banderas por canal (token, app token, rutas de signal-cli, etc).

## Login / logout (interactivo)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Solución de problemas

- Ejecuta `openclaw status --deep` para una sonda amplia.
- Usa `openclaw doctor` para correcciones guiadas.
- `openclaw channels list` imprime `Claude: HTTP 403 ... user:profile` → la instantánea de uso necesita el ámbito `user:profile`. Usa `--no-usage`, o proporciona una clave de sesión de claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), o vuelve a autenticar a través de Claude Code CLI.

## Sonda de capacidades

Obtener pistas de capacidad del proveedor (intenciones/ámbitos donde estén disponibles) más soporte de características estáticas:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notas:

- `--channel` es opcional; omítelo para listar cada canal (incluyendo extensiones).
- `--target` acepta `channel:<id>` o un id de canal numérico sin formato y solo aplica a Discord.
- Las sondas son específicas del proveedor: intenciones de Discord + permisos de canal opcionales; ámbitos de bot + usuario de Slack; banderas de bot de Telegram + webhook; versión de daemon de Signal; token de app de MS Teams + roles/ámbitos de Graph (anotados donde se conocen). Los canales sin sondas reportan `Probe: unavailable`.

## Resolver nombres a IDs

Resolver nombres de canal/usuario a IDs usando el directorio del proveedor:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notas:

- Usa `--kind user|group|auto` para forzar el tipo de objetivo.
- La resolución prefiere coincidencias activas cuando múltiples entradas comparten el mismo nombre.
