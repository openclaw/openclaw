---
summary: "Referencia de la CLI para `openclaw message` (envío + acciones de canal)"
read_when:
  - Al agregar o modificar acciones de la CLI de mensajes
  - Al cambiar el comportamiento de salida de los canales
title: "message"
---

# `openclaw message`

Comando único de salida para enviar mensajes y realizar acciones de canal
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Uso

```
openclaw message <subcommand> [flags]
```

Selección de canal:

- `--channel` requerido si hay más de un canal configurado.
- Si hay exactamente un canal configurado, se convierte en el predeterminado.
- Valores: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost requiere plugin)

Formatos de destino (`--target`):

- WhatsApp: E.164 o JID de grupo
- Telegram: id de chat o `@username`
- Discord: `channel:<id>` o `user:<id>` (o mención `<@id>`; los id numéricos sin formato se tratan como canales)
- Google Chat: `spaces/<spaceId>` o `users/<userId>`
- Slack: `channel:<id>` o `user:<id>` (se acepta el id de canal sin formato)
- Mattermost (plugin): `channel:<id>`, `user:<id>` o `@username` (los id simples se tratan como canales)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` o `username:<name>`/`u:<name>`
- iMessage: identificador, `chat_id:<id>`, `chat_guid:<guid>` o `chat_identifier:<id>`
- MS Teams: id de conversación (`19:...@thread.tacv2`) o `conversation:<id>` o `user:<aad-object-id>`

Búsqueda por nombre:

- Para proveedores compatibles (Discord/Slack/etc), los nombres de canal como `Help` o `#help` se resuelven mediante la caché del directorio.
- En caso de fallo de caché, OpenClaw intentará una búsqueda en vivo del directorio cuando el proveedor lo admita.

## Flags comunes

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (canal o usuario de destino para send/poll/read/etc)
- `--targets <name>` (repetir; solo difusión)
- `--json`
- `--dry-run`
- `--verbose`

## Acciones

### Núcleo

- `send`
  - Canales: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Requerido: `--target`, más `--message` o `--media`
  - Opcional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Solo Telegram: `--buttons` (requiere `channels.telegram.capabilities.inlineButtons` para permitirlo)
  - Solo Telegram: `--thread-id` (id de tema del foro)
  - Solo Slack: `--thread-id` (marca de tiempo del hilo; `--reply-to` usa el mismo campo)
  - Solo WhatsApp: `--gif-playback`

- `poll`
  - Canales: WhatsApp/Discord/MS Teams
  - Requerido: `--target`, `--poll-question`, `--poll-option` (repetir)
  - Opcional: `--poll-multi`
  - Solo Discord: `--poll-duration-hours`, `--message`

- `react`
  - Canales: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Requerido: `--message-id`, `--target`
  - Opcional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Nota: `--remove` requiere `--emoji` (omita `--emoji` para limpiar sus propias reacciones cuando esté admitido; ver /tools/reactions)
  - Solo WhatsApp: `--participant`, `--from-me`
  - Reacciones en grupos de Signal: se requiere `--target-author` o `--target-author-uuid`

- `reactions`
  - Canales: Discord/Google Chat/Slack
  - Requerido: `--message-id`, `--target`
  - Opcional: `--limit`

- `read`
  - Canales: Discord/Slack
  - Requerido: `--target`
  - Opcional: `--limit`, `--before`, `--after`
  - Solo Discord: `--around`

- `edit`
  - Canales: Discord/Slack
  - Requerido: `--message-id`, `--message`, `--target`

- `delete`
  - Canales: Discord/Slack/Telegram
  - Requerido: `--message-id`, `--target`

- `pin` / `unpin`
  - Canales: Discord/Slack
  - Requerido: `--message-id`, `--target`

- `pins` (lista)
  - Canales: Discord/Slack
  - Requerido: `--target`

- `permissions`
  - Canales: Discord
  - Requerido: `--target`

- `search`
  - Canales: Discord
  - Requerido: `--guild-id`, `--query`
  - Opcional: `--channel-id`, `--channel-ids` (repetir), `--author-id`, `--author-ids` (repetir), `--limit`

### Hilos

- `thread create`
  - Canales: Discord
  - Requerido: `--thread-name`, `--target` (id del canal)
  - Opcional: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Canales: Discord
  - Requerido: `--guild-id`
  - Opcional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Canales: Discord
  - Requerido: `--target` (id del hilo), `--message`
  - Opcional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: sin flags adicionales

- `emoji upload`
  - Canales: Discord
  - Requerido: `--guild-id`, `--emoji-name`, `--media`
  - Opcional: `--role-ids` (repetir)

### Stickers

- `sticker send`
  - Canales: Discord
  - Requerido: `--target`, `--sticker-id` (repetir)
  - Opcional: `--message`

- `sticker upload`
  - Canales: Discord
  - Requerido: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Canales / Miembros / Voz

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` para Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Eventos

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Opcional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderación (Discord)

- `timeout`: `--guild-id`, `--user-id` (opcional `--duration-min` o `--until`; omita ambos para limpiar el tiempo de espera)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` también admite `--reason`

### Broadcast

- `broadcast`
  - Canales: cualquier canal configurado; use `--channel all` para apuntar a todos los proveedores
  - Requerido: `--targets` (repetir)
  - Opcional: `--message`, `--media`, `--dry-run`

## Ejemplos

Enviar una respuesta en Discord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Crear una encuesta en Discord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Enviar un mensaje proactivo en Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Crear una encuesta en Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Reaccionar en Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Reaccionar en un grupo de Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Enviar botones en línea de Telegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
