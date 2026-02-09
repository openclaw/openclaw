---
summary: "Referência da CLI para `openclaw message` (envio + ações de canal)"
read_when:
  - Adicionar ou modificar ações da CLI de mensagens
  - Alterar o comportamento de canais de saída
title: "message"
---

# `openclaw message`

Comando único de saída para envio de mensagens e ações de canal
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Uso

```
openclaw message <subcommand> [flags]
```

Seleção de canal:

- `--channel` obrigatório se mais de um canal estiver configurado.
- Se exatamente um canal estiver configurado, ele se torna o padrão.
- Valores: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost requer plugin)

Formatos de destino (`--target`):

- WhatsApp: E.164 ou JID de grupo
- Telegram: id do chat ou `@username`
- Discord: `channel:<id>` ou `user:<id>` (ou menção `<@id>`; ids numéricos brutos são tratados como canais)
- Google Chat: `spaces/<spaceId>` ou `users/<userId>`
- Slack: `channel:<id>` ou `user:<id>` (id bruto do canal é aceito)
- Mattermost (plugin): `channel:<id>`, `user:<id>` ou `@username` (ids simples são tratados como canais)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` ou `username:<name>`/`u:<name>`
- iMessage: identificador, `chat_id:<id>`, `chat_guid:<guid>` ou `chat_identifier:<id>`
- MS Teams: id da conversa (`19:...@thread.tacv2`) ou `conversation:<id>` ou `user:<aad-object-id>`

Busca por nome:

- Para provedores compatíveis (Discord/Slack/etc.), nomes de canais como `Help` ou `#help` são resolvidos via cache de diretório.
- Em caso de falha no cache, o OpenClaw tentará uma busca ao vivo no diretório quando o provedor oferecer suporte.

## Flags comuns

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (canal ou usuário de destino para send/poll/read/etc)
- `--targets <name>` (repetir; somente broadcast)
- `--json`
- `--dry-run`
- `--verbose`

## Ações

### Núcleo

- `send`
  - Canais: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Obrigatório: `--target`, além de `--message` ou `--media`
  - Opcional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Somente Telegram: `--buttons` (requer `channels.telegram.capabilities.inlineButtons` para permitir)
  - Somente Telegram: `--thread-id` (id do tópico do fórum)
  - Somente Slack: `--thread-id` (timestamp do thread; `--reply-to` usa o mesmo campo)
  - Somente WhatsApp: `--gif-playback`

- `poll`
  - Canais: WhatsApp/Discord/MS Teams
  - Obrigatório: `--target`, `--poll-question`, `--poll-option` (repetir)
  - Opcional: `--poll-multi`
  - Somente Discord: `--poll-duration-hours`, `--message`

- `react`
  - Canais: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Obrigatório: `--message-id`, `--target`
  - Opcional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Nota: `--remove` requer `--emoji` (omita `--emoji` para limpar suas próprias reações quando suportado; veja /tools/reactions)
  - Somente WhatsApp: `--participant`, `--from-me`
  - Reações em grupo do Signal: `--target-author` ou `--target-author-uuid` obrigatórios

- `reactions`
  - Canais: Discord/Google Chat/Slack
  - Obrigatório: `--message-id`, `--target`
  - Opcional: `--limit`

- `read`
  - Canais: Discord/Slack
  - Obrigatório: `--target`
  - Opcional: `--limit`, `--before`, `--after`
  - Somente Discord: `--around`

- `edit`
  - Canais: Discord/Slack
  - Obrigatório: `--message-id`, `--message`, `--target`

- `delete`
  - Canais: Discord/Slack/Telegram
  - Obrigatório: `--message-id`, `--target`

- `pin` / `unpin`
  - Canais: Discord/Slack
  - Obrigatório: `--message-id`, `--target`

- `pins` (lista)
  - Canais: Discord/Slack
  - Obrigatório: `--target`

- `permissions`
  - Canais: Discord
  - Obrigatório: `--target`

- `search`
  - Canais: Discord
  - Obrigatório: `--guild-id`, `--query`
  - Opcional: `--channel-id`, `--channel-ids` (repetir), `--author-id`, `--author-ids` (repetir), `--limit`

### Threads

- `thread create`
  - Canais: Discord
  - Obrigatório: `--thread-name`, `--target` (id do canal)
  - Opcional: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Canais: Discord
  - Obrigatório: `--guild-id`
  - Opcional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Canais: Discord
  - Obrigatório: `--target` (id do thread), `--message`
  - Opcional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: sem flags adicionais

- `emoji upload`
  - Canais: Discord
  - Obrigatório: `--guild-id`, `--emoji-name`, `--media`
  - Opcional: `--role-ids` (repetir)

### Stickers

- `sticker send`
  - Canais: Discord
  - Obrigatório: `--target`, `--sticker-id` (repetir)
  - Opcional: `--message`

- `sticker upload`
  - Canais: Discord
  - Obrigatório: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Funções / Canais / Membros / Voz

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

### Moderação (Discord)

- `timeout`: `--guild-id`, `--user-id` (opcional `--duration-min` ou `--until`; omita ambos para limpar o timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` também oferece suporte a `--reason`

### Broadcast

- `broadcast`
  - Canais: qualquer canal configurado; use `--channel all` para direcionar todos os provedores
  - Obrigatório: `--targets` (repetir)
  - Opcional: `--message`, `--media`, `--dry-run`

## Exemplos

Enviar uma resposta no Discord:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Criar uma enquete no Discord:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Enviar uma mensagem proativa no Teams:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Criar uma enquete no Teams:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Reagir no Slack:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Reagir em um grupo do Signal:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Enviar botões inline do Telegram:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
