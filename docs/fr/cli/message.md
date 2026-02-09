---
summary: "Reference CLI pour `openclaw message` (envoi + actions de canal)"
read_when:
  - Ajout ou modification des actions CLI de message
  - Changement du comportement des canaux sortants
title: "message"
---

# `openclaw message`

Commande sortante unique pour l’envoi de messages et les actions de canal
(Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Utilisation

```
openclaw message <subcommand> [flags]
```

Sélection du canal :

- `--channel` requis si plus d’un canal est configuré.
- Si exactement un canal est configuré, il devient le canal par défaut.
- Valeurs : `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost nécessite un plugin)

Formats de cible (`--target`) :

- WhatsApp : E.164 ou JID de groupe
- Telegram : id de discussion ou `@username`
- Discord : `channel:<id>` ou `user:<id>` (ou mention `<@id>` ; les identifiants numériques bruts sont traités comme des canaux)
- Google Chat : `spaces/<spaceId>` ou `users/<userId>`
- Slack : `channel:<id>` ou `user:<id>` (l’id de canal brut est accepté)
- Mattermost (plugin) : `channel:<id>`, `user:<id>` ou `@username` (les identifiants nus sont traités comme des canaux)
- Signal : `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` ou `username:<name>`/`u:<name>`
- iMessage : handle, `chat_id:<id>`, `chat_guid:<guid>` ou `chat_identifier:<id>`
- MS Teams : id de conversation (`19:...@thread.tacv2`) ou `conversation:<id>` ou `user:<aad-object-id>`

Recherche par nom :

- Pour les fournisseurs pris en charge (Discord/Slack/etc.), les noms de canal comme `Help` ou `#help` sont résolus via le cache d’annuaire.
- En cas d’absence dans le cache, OpenClaw tentera une recherche d’annuaire en direct lorsque le fournisseur le prend en charge.

## Drapeaux courants

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (canal ou utilisateur cible pour send/poll/read/etc.)
- `--targets <name>` (répéter ; diffusion uniquement)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Canaux : WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Requis : `--target`, plus `--message` ou `--media`
  - Optionnel : `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram uniquement : `--buttons` (nécessite `channels.telegram.capabilities.inlineButtons` pour l’autoriser)
  - Telegram uniquement : `--thread-id` (id de sujet de forum)
  - Slack uniquement : `--thread-id` (horodatage de fil ; `--reply-to` utilise le même champ)
  - WhatsApp uniquement : `--gif-playback`

- `poll`
  - Canaux : WhatsApp/Discord/MS Teams
  - Requis : `--target`, `--poll-question`, `--poll-option` (répéter)
  - Optionnel : `--poll-multi`
  - Discord uniquement : `--poll-duration-hours`, `--message`

- `react`
  - Canaux : Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Requis : `--message-id`, `--target`
  - Optionnel : `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Remarque : `--remove` nécessite `--emoji` (omettre `--emoji` pour effacer ses propres réactions lorsque pris en charge ; voir /tools/reactions)
  - WhatsApp uniquement : `--participant`, `--from-me`
  - Réactions de groupe Signal : `--target-author` ou `--target-author-uuid` requis

- `reactions`
  - Canaux : Discord/Google Chat/Slack
  - Requis : `--message-id`, `--target`
  - Optionnel : `--limit`

- `read`
  - Canaux : Discord/Slack
  - Requis : `--target`
  - Optionnel : `--limit`, `--before`, `--after`
  - Discord uniquement : `--around`

- `edit`
  - Canaux : Discord/Slack
  - Requis : `--message-id`, `--message`, `--target`

- `delete`
  - Canaux : Discord/Slack/Telegram
  - Requis : `--message-id`, `--target`

- `pin` / `unpin`
  - Canaux : Discord/Slack
  - Requis : `--message-id`, `--target`

- `pins` (liste)
  - Canaux : Discord/Slack
  - Requis : `--target`

- `permissions`
  - Canaux : Discord
  - Requis : `--target`

- `search`
  - Canaux : Discord
  - Requis : `--guild-id`, `--query`
  - Optionnel : `--channel-id`, `--channel-ids` (répéter), `--author-id`, `--author-ids` (répéter), `--limit`

### Fil de discussion

- `thread create`
  - Canaux : Discord
  - Requis : `--thread-name`, `--target` (id de canal)
  - Optionnel : `--message-id`, `--auto-archive-min`

- `thread list`
  - Canaux : Discord
  - Requis : `--guild-id`
  - Optionnel : `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Canaux : Discord
  - Requis : `--target` (id de fil), `--message`
  - Optionnel : `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord : `--guild-id`
  - Slack : aucune option supplémentaire

- `emoji upload`
  - Canaux : Discord
  - Requis : `--guild-id`, `--emoji-name`, `--media`
  - Optionnel : `--role-ids` (répéter)

### Autocollants

- `sticker send`
  - Canaux : Discord
  - Requis : `--target`, `--sticker-id` (répéter)
  - Optionnel : `--message`

- `sticker upload`
  - Canaux : Discord
  - Requis : `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Rôles / Canaux / Membres / Voix

- `role info` (Discord) : `--guild-id`
- `role add` / `role remove` (Discord) : `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord) : `--target`
- `channel list` (Discord) : `--guild-id`
- `member info` (Discord/Slack) : `--user-id` (+ `--guild-id` pour Discord)
- `voice status` (Discord) : `--guild-id`, `--user-id`

### Événements

- `event list` (Discord) : `--guild-id`
- `event create` (Discord) : `--guild-id`, `--event-name`, `--start-time`
  - Optionnel : `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Modération (Discord)

- `timeout` : `--guild-id`, `--user-id` (optionnel `--duration-min` ou `--until` ; omettre les deux pour effacer le délai)
- `kick` : `--guild-id`, `--user-id` (+ `--reason`)
- `ban` : `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` prend également en charge `--reason`

### Broadcast

- `broadcast`
  - Canaux : tout canal configuré ; utilisez `--channel all` pour cibler tous les fournisseurs
  - Requis : `--targets` (répéter)
  - Optionnel : `--message`, `--media`, `--dry-run`

## Exemples

Envoyer une réponse Discord :

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Créer un sondage Discord :

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Envoyer un message proactif Teams :

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Créer un sondage Teams :

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Réagir dans Slack :

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Réagir dans un groupe Signal :

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Envoyer des boutons en ligne Telegram :

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
