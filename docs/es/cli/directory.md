---
summary: "Referencia de la CLI para `openclaw directory` (self, peers, groups)"
read_when:
  - Desea buscar IDs de contactos/grupos/self para un canal
  - Está desarrollando un adaptador de directorio de canal
title: "directory"
---

# `openclaw directory`

Búsquedas de directorio para canales que lo admiten (contactos/peers, grupos y “yo”).

## Common flags

- `--channel <name>`: id/alias del canal (requerido cuando hay varios canales configurados; automático cuando solo hay uno configurado)
- `--account <id>`: id de la cuenta (predeterminado: valor predeterminado del canal)
- `--json`: salida JSON

## Notes

- `directory` está pensado para ayudarle a encontrar IDs que puede pegar en otros comandos (especialmente `openclaw message send --target ...`).
- Para muchos canales, los resultados están respaldados por configuración (listas de permitidos / grupos configurados) en lugar de un directorio del proveedor en vivo.
- La salida predeterminada es `id` (y a veces `name`) separados por una tabulación; use `--json` para scripting.

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupo)
- Telegram: `@username` o id de chat numérico; los grupos son ids numéricos
- Slack: `user:U…` y `channel:C…`
- Discord: `user:<id>` y `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` o `#alias:server`
- Microsoft Teams (plugin): `user:<id>` y `conversation:<id>`
- Zalo (plugin): id de usuario (API del bot)
- Zalo Personal / `zalouser` (plugin): id de hilo (DM/grupo) de `zca` (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
