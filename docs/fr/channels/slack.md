---
summary: "Configuration Slack pour le mode socket ou webhook HTTP"
read_when: "Configurer Slack ou depanner le mode socket/HTTP de Slack"
title: "Slack"
---

# Slack

## Mode socket (par defaut)

### Demarrage rapide (debutant)

1. Creez une application Slack et activez le **Mode socket**.
2. Creez un **App Token** (`xapp-...`) et un **Bot Token** (`xoxb-...`).
3. Definissez les tokens pour OpenClaw et demarrez la Gateway (passerelle).

Configuration minimale :

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Configuration

1. Creez une application Slack (From scratch) sur https://api.slack.com/apps.
2. **Mode socket** → activez l’option. Puis allez dans **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** avec le scope `connections:write`. Copiez l’**App Token** (`xapp-...`).
3. **OAuth & Permissions** → ajoutez les scopes du bot (utilisez le manifeste ci-dessous). Cliquez sur **Install to Workspace**. Copiez le **Bot User OAuth Token** (`xoxb-...`).
4. Optionnel : **OAuth & Permissions** → ajoutez des **User Token Scopes** (voir la liste en lecture seule ci-dessous). Reinstallez l’application et copiez le **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → activez les evenements et abonnez-vous a :
   - `message.*` (inclut les editions/suppressions/diffusions de fils)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Invitez le bot dans les canaux que vous souhaitez qu’il lise.
7. Slash Commands → creez `/openclaw` si vous utilisez `channels.slack.slashCommand`. Si vous activez les commandes natives, ajoutez une commande slash par commande integree (memes noms que `/help`). Par defaut, le mode natif est desactive pour Slack, sauf si vous definissez `channels.slack.commands.native: true` (la valeur globale `commands.native` est `"auto"`, ce qui laisse Slack desactive).
8. App Home → activez l’onglet **Messages** afin que les utilisateurs puissent envoyer des Messages prives au bot.

Utilisez le manifeste ci-dessous pour que les scopes et les evenements restent synchronises.

Prise en charge multi-comptes : utilisez `channels.slack.accounts` avec des tokens par compte et `name` en option. Voir [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) pour le modele partage.

### Configuration OpenClaw (minimale)

Definissez les tokens via des variables d'environnement (recommande) :

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Ou via la configuration :

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Token utilisateur (optionnel)

OpenClaw peut utiliser un token utilisateur Slack (`xoxp-...`) pour les operations de lecture (historique,
epingles, reactions, emoji, informations de membres). Par defaut, cela reste en lecture seule : les lectures
preferent le token utilisateur lorsqu’il est present, et les ecritures utilisent toujours le token du bot sauf
si vous y consentez explicitement. Meme avec `userTokenReadOnly: false`, le token du bot reste
prefere pour les ecritures lorsqu’il est disponible.

Les tokens utilisateur sont configures dans le fichier de configuration (pas de prise en charge par variables d'environnement). Pour le
multi-comptes, definissez `channels.slack.accounts.<id>.userToken`.

Exemple avec tokens bot + app + utilisateur :

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Exemple avec userTokenReadOnly defini explicitement (autoriser les ecritures via le token utilisateur) :

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Utilisation des tokens

- Operations de lecture (historique, liste des reactions, liste des epingles, liste des emoji, informations des membres,
  recherche) : preference pour le token utilisateur lorsqu’il est configure, sinon le token du bot.
- Operations d’ecriture (envoyer/editer/supprimer des messages, ajouter/supprimer des reactions, epingler/desepingler,
  televersements de fichiers) : utilisent le token du bot par defaut. Si `userTokenReadOnly: false` et
  qu’aucun token de bot n’est disponible, OpenClaw bascule vers le token utilisateur.

### Contexte d’historique

- `channels.slack.historyLimit` (ou `channels.slack.accounts.*.historyLimit`) controle le nombre de messages recents de canal/groupe integres dans le prompt.
- Repli sur `messages.groupChat.historyLimit`. Definissez `0` pour desactiver (par defaut 50).

## Mode HTTP (API Events)

Utilisez le mode webhook HTTP lorsque votre Gateway (passerelle) est accessible par Slack via HTTPS (typique pour des deploiements serveur).
Le mode HTTP utilise l’API Events + Interactivity + Slash Commands avec une URL de requete partagee.

### Configuration (mode HTTP)

1. Creez une application Slack et **desactivez le Mode socket** (optionnel si vous n’utilisez que HTTP).
2. **Basic Information** → copiez le **Signing Secret**.
3. **OAuth & Permissions** → installez l’application et copiez le **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → activez les evenements et definissez l’**URL de requete** vers le chemin webhook de votre gateway (par defaut `/slack/events`).
5. **Interactivity & Shortcuts** → activez et definissez la meme **URL de requete**.
6. **Slash Commands** → definissez la meme **URL de requete** pour vos commande(s).

Exemple d’URL de requete :
`https://gateway-host/slack/events`

### Configuration OpenClaw (minimale)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Mode HTTP multi-comptes : definissez `channels.slack.accounts.<id>.mode = "http"` et fournissez un
`webhookPath` unique par compte afin que chaque application Slack pointe vers sa propre URL.

### Manifeste (optionnel)

Utilisez ce manifeste d’application Slack pour creer l’application rapidement (ajustez le nom/la commande si vous le souhaitez). Incluez les
scopes utilisateur si vous prevoyez de configurer un token utilisateur.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Si vous activez les commandes natives, ajoutez une entree `slash_commands` par commande que vous souhaitez exposer (correspondant a la liste `/help`). Surchargez avec `channels.slack.commands.native`.

## Scopes (actuels vs optionnels)

L’API Conversations de Slack est scopee par type : vous n’avez besoin que des scopes pour les
types de conversations que vous utilisez reellement (channels, groups, im, mpim). Voir
https://docs.slack.dev/apis/web-api/using-the-conversations-api/ pour la vue d’ensemble.

### Scopes du token du bot (requis)

- `chat:write` (envoyer/mettre a jour/supprimer des messages via `chat.postMessage`)
  https://docs.slack.dev/reference/methods/chat.postMessage
- `im:write` (ouvrir des Messages prives via `conversations.open` pour les Messages prives utilisateur)
  https://docs.slack.dev/reference/methods/conversations.open
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  https://docs.slack.dev/reference/methods/conversations.history
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  https://docs.slack.dev/reference/methods/conversations.info
- `users:read` (recherche d’utilisateurs)
  https://docs.slack.dev/reference/methods/users.info
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  https://docs.slack.dev/reference/methods/reactions.get
  https://docs.slack.dev/reference/methods/reactions.add
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  https://docs.slack.dev/reference/scopes/pins.read
  https://docs.slack.dev/reference/scopes/pins.write
- `emoji:read` (`emoji.list`)
  https://docs.slack.dev/reference/scopes/emoji.read
- `files:write` (televersements via `files.uploadV2`)
  https://docs.slack.dev/messaging/working-with-files/#upload

### Scopes du token utilisateur (optionnels, lecture seule par defaut)

Ajoutez-les sous **User Token Scopes** si vous configurez `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Non requis aujourd’hui (mais probables a l’avenir)

- `mpim:write` (uniquement si nous ajoutons l’ouverture de group-DM / demarrage de DM via `conversations.open`)
- `groups:write` (uniquement si nous ajoutons la gestion des canaux prives : creer/renommer/inviter/archiver)
- `chat:write.public` (uniquement si nous voulons publier dans des canaux dont le bot ne fait pas partie)
  https://docs.slack.dev/reference/scopes/chat.write.public
- `users:read.email` (uniquement si nous avons besoin des champs email depuis `users.info`)
  https://docs.slack.dev/changelog/2017-04-narrowing-email-access
- `files:read` (uniquement si nous commencons a lister/lire les metadonnees de fichiers)

## Configuration

Slack utilise uniquement le Mode socket (pas de serveur webhook HTTP). Fournissez les deux tokens :

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Les jetons peuvent également être fournis via des variables env :

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Les reactions d’accuse de reception sont controlees globalement via `messages.ackReaction` +
`messages.ackReactionScope`. Utilisez `messages.removeAckAfterReply` pour effacer la
reaction d’accuse de reception apres la reponse du bot.

## Limites

- Le texte sortant est fragmente a `channels.slack.textChunkLimit` (par defaut 4000).
- Fragmentation optionnelle par retours a la ligne : definissez `channels.slack.chunkMode="newline"` pour scinder sur les lignes vides (limites de paragraphes) avant la fragmentation par longueur.
- Les televersements de medias sont limites par `channels.slack.mediaMaxMb` (par defaut 20).

## Fil de reponse

Par defaut, OpenClaw repond dans le canal principal. Utilisez `channels.slack.replyToMode` pour controler le fil automatique :

| Mode    | Comportement                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Par defaut.** Repondre dans le canal principal. Ne creer un fil que si le message declencheur etait deja dans un fil.                                                             |
| `first` | La premiere reponse va dans le fil (sous le message declencheur), les reponses suivantes vont dans le canal principal. Utile pour conserver le contexte sans encombrer les fils. |
| `all`   | Toutes les reponses vont dans le fil. Garde les conversations contenues mais peut reduire la visibilite.                                                                                            |

Le mode s’applique aux reponses automatiques et aux appels d’outils de l’agent (`slack sendMessage`).

### Fil par type de discussion

Vous pouvez configurer un comportement de fil different par type de discussion en definissant `channels.slack.replyToModeByChatType` :

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Types de discussion pris en charge :

- `direct` : Messages prives 1:1 (Slack `im`)
- `group` : Messages prives de groupe / MPIMs (Slack `mpim`)
- `channel` : canaux standards (publics/prives)

Priorite :

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Fournisseur par défaut (`off`)

Le parametre historique `channels.slack.dm.replyToMode` est toujours accepte comme repli pour `direct` lorsqu’aucune surcharge par type de discussion n’est definie.

Exemples :

Sujet de discussion uniquement :

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Fil pour les Messages prives de groupe mais canaux a la racine :

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Faire des fils de discussion, garder les MP à la racine :

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Balises de fil manuel

Pour un controle fin, utilisez ces balises dans les reponses de l’agent :

- `[[reply_to_current]]` — repondre au message declencheur (demarrer/continuer un fil).
- `[[reply_to:<id>]]` — repondre a un identifiant de message specifique.

## Sessions + routage

- Les Messages prives partagent la session `main` (comme WhatsApp/Telegram).
- Les canaux correspondent a des sessions `agent:<agentId>:slack:channel:<channelId>`.
- Les commandes slash utilisent des sessions `agent:<agentId>:slack:slash:<userId>` (prefixe configurable via `channels.slack.slashCommand.sessionPrefix`).
- Si Slack ne fournit pas `channel_type`, OpenClaw l’infere a partir du prefixe d’ID de canal (`D`, `C`, `G`) et utilise par defaut `channel` afin de maintenir des cles de session stables.
- L’enregistrement des commandes natives utilise `commands.native` (valeur globale par defaut `"auto"` → Slack desactive) et peut etre surcharge par espace de travail avec `channels.slack.commands.native`. Les commandes texte necessitent des messages `/...` autonomes et peuvent etre desactivees avec `commands.text: false`. Les commandes slash Slack sont gerees dans l’application Slack et ne sont pas supprimees automatiquement. Utilisez `commands.useAccessGroups: false` pour contourner les verifications de groupes d’acces pour les commandes.
- Liste complete des commandes + configuration : [Slash commands](/tools/slash-commands)

## Sécurité DM (jumelage)

- Par defaut : `channels.slack.dm.policy="pairing"` — les expediteurs de Messages prives inconnus recoivent un code d’appairage (expire apres 1 heure).
- Approbation via : `openclaw pairing approve slack <code>`.
- Pour autoriser tout le monde : definissez `channels.slack.dm.policy="open"` et `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` accepte des identifiants utilisateur, des @handles ou des emails (resolus au demarrage lorsque les tokens le permettent). L’assistant accepte les noms d’utilisateur et les resout en identifiants pendant la configuration lorsque les tokens le permettent.

## Politique de groupe

- `channels.slack.groupPolicy` controle la gestion des canaux (`open|disabled|allowlist`).
- `allowlist` exige que les canaux soient listes dans `channels.slack.channels`.
- Si vous ne definissez que `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` et ne creez jamais de section `channels.slack`,
  les valeurs par defaut d’execution definissent `groupPolicy` sur `open`. Ajoutez `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, ou une liste d’autorisation de canaux pour verrouiller.
- L’assistant de configuration accepte les noms `#channel` et les resout en identifiants lorsque possible
  (publics + prives) ; s’il existe plusieurs correspondances, il prefere le canal actif.
- Au demarrage, OpenClaw resout les noms de canaux/utilisateurs dans les listes d’autorisation en identifiants (lorsque les tokens le permettent)
  et journalise le mapping ; les entrees non resolues sont conservees telles quelles.
- Pour n’autoriser **aucun canal**, definissez `channels.slack.groupPolicy: "disabled"` (ou conservez une liste d’autorisation vide).

Options de canal (`channels.slack.channels.<id>` ou `channels.slack.channels.<name>`) :

- `allow` : autoriser/refuser le canal lorsque `groupPolicy="allowlist"`.
- `requireMention` : controle des mentions pour le canal.
- `tools` : surcharges optionnelles de politique d’outils par canal (`allow`/`deny`/`alsoAllow`).
- `toolsBySender` : surcharges optionnelles de politique d’outils par expediteur au sein du canal (cles = identifiants d’expediteur/@handles/emails ; joker `"*"` pris en charge).
- `allowBots` : autoriser les messages rediges par le bot dans ce canal (par defaut : false).
- `users` : liste d’autorisation utilisateur optionnelle par canal.
- `skills` : filtre de Skills (omettre = toutes les Skills, vide = aucune).
- `systemPrompt` : invite systeme supplementaire pour le canal (combinee avec le sujet/l’objectif).
- `enabled` : definissez `false` pour desactiver le canal.

## Cibles de livraison

Utilisez-les avec des envois cron/CLI :

- `user:<id>` pour les Messages prives
- `channel:<id>` pour les canaux

## Actions d’outils

Les actions d’outils Slack peuvent etre controlees via `channels.slack.actions.*` :

| Groupe d’actions | Par défaut | Notes                         |
| ---------------- | ---------- | ----------------------------- |
| reactions        | active     | React + lister les reactions  |
| messages         | active     | Lire/envoyer/editer/supprimer |
| pins             | active     | Epingler/desepingler/lister   |
| memberInfo       | active     | Informations de membres       |
| emojiList        | active     | Liste d’emoji personnalises   |

## Notes de securite

- Les ecritures utilisent par defaut le token du bot afin que les actions modifiant l’etat restent limitees aux
  permissions et a l’identite du bot de l’application.
- Definir `userTokenReadOnly: false` permet d’utiliser le token utilisateur pour les
  operations d’ecriture lorsqu’aucun token de bot n’est disponible, ce qui signifie que les actions s’executent avec l’acces de l’utilisateur installateur. Traitez le token utilisateur comme hautement privilegie et maintenez des controles d’actions et des listes d’autorisation stricts.
- Si vous activez les ecritures via token utilisateur, assurez-vous que le token utilisateur inclut les scopes d’ecriture attendus (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) sinon ces operations echoueront.

## Problemes courants

Exécutez d'abord cette échelle :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

Ensuite, confirmez l'état d'appairage du DM si nécessaire:

```bash
openclaw pairing list slack
```

Échecs communs :

- Réponses connectées mais pas de canal : canal bloqué par `groupPolicy` ou non dans la liste de diffusion `channels.slack.channels`.
- DMs ignorés: l'expéditeur n'est pas approuvé lorsque `channels.slack.dm.policy="appairage"`.
- Erreurs d'API (`missing_scope`, `not_in_channel`, échecs d'authentification): les tokens bot/app ou Slack sont incomplets.

channels/signal.md

## Notes

- Le controle des mentions est gere via `channels.slack.channels` (definissez `requireMention` sur `true`) ; `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) comptent egalement comme mentions.
- Surcharge multi-agent : definissez des motifs par agent sur `agents.list[].groupChat.mentionPatterns`.
- Les notifications de reactions suivent `channels.slack.reactionNotifications` (utilisez `reactionAllowlist` avec le mode `allowlist`).
- Les messages rediges par le bot sont ignores par defaut ; activez via `channels.slack.allowBots` ou `channels.slack.channels.<id>.allowBots`.
- Avertissement : si vous autorisez les reponses a d’autres bots (`channels.slack.allowBots=true` ou `channels.slack.channels.<id>.allowBots=true`), evitez les boucles de reponse bot-a-bot avec des listes d’autorisation `requireMention`, `channels.slack.channels.<id>.users`, et/ou des garde-fous clairs dans `AGENTS.md` et `SOUL.md`.
- Pour l’outil Slack, la semantique de suppression de reactions est decrite dans [/tools/reactions](/tools/reactions).
- Les pieces jointes sont telechargees vers le stockage media lorsque cela est autorise et en dessous de la limite de taille.
