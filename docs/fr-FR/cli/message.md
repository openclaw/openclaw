---
summary: "Référence CLI pour `openclaw message` (envoi + actions canal)"
read_when:
  - Ajout ou modification d'actions CLI message
  - Changement comportement canal sortant
title: "message"
---

# `openclaw message`

Commande sortante unique pour envoyer messages et actions canal (Discord/Google Chat/Slack/Mattermost (plugin)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Utilisation

```
openclaw message <sous-commande> [drapeaux]
```

Sélection de canal :

- `--channel` requis si plus d'un canal est configuré.
- Si exactement un canal est configuré, il devient le défaut.
- Valeurs : `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost nécessite plugin)

Formats de cible (`--target`) :

- WhatsApp : E.164 ou JID de groupe
- Telegram : id de chat ou `@username`
- Discord : `channel:<id>` ou `user:<id>` (ou mention `<@id>` ; les ids numériques bruts sont traités comme canaux)
- Google Chat : `spaces/<spaceId>` ou `users/<userId>`
- Slack : `channel:<id>` ou `user:<id>` (id de canal brut accepté)
- Mattermost (plugin) : `channel:<id>`, `user:<id>`, ou `@username` (ids nus traités comme canaux)
- Signal : `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, ou `username:<name>`/`u:<name>`
- iMessage : handle, `chat_id:<id>`, `chat_guid:<guid>`, ou `chat_identifier:<id>`
- MS Teams : id de conversation (`19:...@thread.tacv2`) ou `conversation:<id>` ou `user:<aad-object-id>`

Recherche de nom :

- Pour les fournisseurs supportés (Discord/Slack/etc), les noms de canal comme `Aide` ou `#aide` sont résolus via le cache de répertoire.
- En cas d'absence de cache, OpenClaw tentera une recherche de répertoire en direct quand le fournisseur la supporte.

## Drapeaux courants

- `--channel <nom>`
- `--account <id>`
- `--target <dest>` (canal ou utilisateur cible pour send/poll/read/etc)
- `--targets <nom>` (répéter ; diffusion uniquement)
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Canaux : WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams
  - Requis : `--target`, plus `--message` ou `--media`
  - Optionnel : `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram uniquement : `--buttons` (nécessite `channels.telegram.capabilities.inlineButtons` pour l'autoriser)
  - Telegram uniquement : `--thread-id` (id de sujet de forum)
  - Slack uniquement : `--thread-id` (horodatage de fil ; `--reply-to` utilise le même champ)
  - WhatsApp uniquement : `--gif-playback`

- `poll`
  - Canaux : WhatsApp/Telegram/Discord/Matrix/MS Teams
  - Requis : `--target`, `--poll-question`, `--poll-option` (répéter)
  - Optionnel : `--poll-multi`
  - Discord uniquement : `--poll-duration-hours`, `--silent`, `--message`
  - Telegram uniquement : `--poll-duration-seconds` (5-600), `--silent`, `--poll-anonymous` / `--poll-public`, `--thread-id`

- `react`
  - Canaux : Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Requis : `--message-id`, `--target`
  - Optionnel : `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Note : `--remove` nécessite `--emoji` (omettez `--emoji` pour effacer propres réactions où supporté ; voir /fr-FR/tools/reactions)
  - WhatsApp uniquement : `--participant`, `--from-me`
  - Réactions de groupe Signal : `--target-author` ou `--target-author-uuid` requis

- `reactions`
  - Canaux : Discord/Google Chat/Slack
  - Requis : `--message-id`, `--target`
  - Optionnel : `--limit`

- `read`
  - Canaux : Discord/Slack
  - Requis : `--target`
  - Optionnel : `--limit`, `--before`, `--after`
  - Discord uniquement : `--around`

- `edit`
  - Canaux : Discord/Slack
  - Requis : `--message-id`, `--message`, `--target`

- `delete`
  - Canaux : Discord/Slack/Telegram
  - Requis : `--message-id`, `--target`

- `pin` / `unpin`
  - Canaux : Discord/Slack/Telegram
  - Requis : `--message-id`, `--target`

## Exemples

### Envoyer un message simple

```bash
openclaw message send --channel whatsapp --target "+15555550123" --message "Bonjour !"
```

### Envoyer avec média

```bash
openclaw message send --channel telegram --target "@utilisateur" --message "Regardez ça" --media "/chemin/vers/image.jpg"
```

### Créer un sondage

```bash
openclaw message poll --channel telegram --target "@canal" \
  --poll-question "Quel est votre langage préféré ?" \
  --poll-option "TypeScript" \
  --poll-option "Python" \
  --poll-option "Rust"
```

### Réagir à un message

```bash
openclaw message react --channel discord --target "channel:123" \
  --message-id "456" --emoji "👍"
```

## Voir aussi

- [Canaux](/fr-FR/channels)
- [Configuration](/fr-FR/gateway/configuration)
