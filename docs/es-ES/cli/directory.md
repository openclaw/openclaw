---
summary: "Referencia CLI para `openclaw directory` (self, peers, groups)"
read_when:
  - Quieres buscar ids de contactos/grupos/self para un canal
  - Estás desarrollando un adaptador de directorio de canal
title: "directory"
---

# `openclaw directory`

Búsquedas de directorio para canales que lo soportan (contactos/pares, grupos y "yo").

## Banderas comunes

- `--channel <name>`: id/alias del canal (requerido cuando se configuran múltiples canales; auto cuando solo uno está configurado)
- `--account <id>`: id de cuenta (predeterminado: predeterminado del canal)
- `--json`: salida JSON

## Notas

- `directory` está destinado a ayudarte a encontrar IDs que puedes pegar en otros comandos (especialmente `openclaw message send --target ...`).
- Para muchos canales, los resultados están respaldados por configuración (listas de permitidos / grupos configurados) en lugar de un directorio de proveedor en vivo.
- La salida predeterminada es `id` (y a veces `name`) separados por una tabulación; usa `--json` para scripting.

## Usar resultados con `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hola"
```

## Formatos de ID (por canal)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupo)
- Telegram: `@username` o id de chat numérico; grupos son ids numéricos
- Slack: `user:U…` y `channel:C…`
- Discord: `user:<id>` y `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, o `#alias:server`
- Microsoft Teams (plugin): `user:<id>` y `conversation:<id>`
- Zalo (plugin): id de usuario (Bot API)
- Zalo Personal / `zalouser` (plugin): id de hilo (DM/grupo) de `zca` (`me`, `friend list`, `group list`)

## Self ("yo")

```bash
openclaw directory self --channel zalouser
```

## Pares (contactos/usuarios)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Grupos

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
