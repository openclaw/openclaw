---
summary: "Configuration Slack et comportement au runtime (Socket Mode + API HTTP Events)"
read_when:
  - Configuration de Slack ou débogage du mode socket/HTTP Slack
title: "Slack"
---

# Slack

Statut : prêt pour la production pour les DM + canaux via les intégrations d'app Slack. Le mode par défaut est Socket Mode ; le mode HTTP Events API est également supporté.

<CardGroup cols={3}>
  <Card title="Appairage" icon="link" href="/fr-FR/channels/pairing">
    Les DM Slack utilisent par défaut le mode appairage.
  </Card>
  <Card title="Commandes slash" icon="terminal" href="/fr-FR/tools/slash-commands">
    Comportement des commandes natives et catalogue de commandes.
  </Card>
  <Card title="Dépannage des canaux" icon="wrench" href="/fr-FR/channels/troubleshooting">
    Diagnostics inter-canaux et procédures de réparation.
  </Card>
</CardGroup>

## Configuration rapide

<Tabs>
  <Tab title="Socket Mode (par défaut)">
    <Steps>
      <Step title="Créer l'app Slack et les tokens">
        Dans les paramètres de l'app Slack :

        - activer **Socket Mode**
        - créer un **App Token** (`xapp-...`) avec `connections:write`
        - installer l'app et copier le **Bot Token** (`xoxb-...`)
      </Step>

      <Step title="Configurer OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        Solution de secours env (compte par défaut uniquement) :

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="S'abonner aux événements de l'app">
        S'abonner aux événements du bot pour :

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        Activer également App Home **Messages Tab** pour les DM.
      </Step>

      <Step title="Démarrer la passerelle">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="Mode HTTP Events API">
    <Steps>
      <Step title="Configurer l'app Slack pour HTTP">

        - définir le mode sur HTTP (`channels.slack.mode="http"`)
        - copier le **Signing Secret** Slack
        - définir Event Subscriptions + Interactivity + Slash command Request URL sur le même chemin webhook (par défaut `/slack/events`)

      </Step>

      <Step title="Configurer OpenClaw en mode HTTP">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "votre-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

      </Step>

      <Step title="Utiliser des chemins webhook uniques pour multi-compte HTTP">
        Le mode HTTP par compte est supporté.

        Donnez à chaque compte un `webhookPath` distinct pour que les enregistrements ne se chevauchent pas.
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Modèle de token

- `botToken` + `appToken` sont requis pour Socket Mode.
- Le mode HTTP nécessite `botToken` + `signingSecret`.
- Les tokens de config remplacent la solution de secours env.
- La solution de secours env `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` s'applique uniquement au compte par défaut.
- `userToken` (`xoxp-...`) est config uniquement (pas de solution de secours env) et par défaut en comportement lecture seule (`userTokenReadOnly: true`).
- Optionnel : ajoutez `chat:write.customize` si vous voulez que les messages sortants utilisent l'identité de l'agent actif (`username` et icône personnalisés). `icon_emoji` utilise la syntaxe `:emoji_name:`.

<Tip>
Pour les actions/lectures de répertoire, le token utilisateur peut être préféré quand configuré. Pour les écritures, le token bot reste préféré ; les écritures de token utilisateur ne sont autorisées que quand `userTokenReadOnly: false` et le token bot n'est pas disponible.
</Tip>

## Contrôle d'accès et routage

<Tabs>
  <Tab title="Politique DM">
    `channels.slack.dmPolicy` contrôle l'accès DM (ancien : `channels.slack.dm.policy`) :

    - `pairing` (par défaut)
    - `allowlist`
    - `open` (nécessite que `channels.slack.allowFrom` inclue `"*"` ; ancien : `channels.slack.dm.allowFrom`)
    - `disabled`

    Drapeaux DM :

    - `dm.enabled` (par défaut true)
    - `channels.slack.allowFrom` (préféré)
    - `dm.allowFrom` (ancien)
    - `dm.groupEnabled` (DM de groupe par défaut false)
    - `dm.groupChannels` (liste blanche MPIM optionnelle)

    L'appairage dans les DM utilise `openclaw pairing approve slack <code>`.

  </Tab>

  <Tab title="Politique de canal">
    `channels.slack.groupPolicy` contrôle la gestion des canaux :

    - `open`
    - `allowlist`
    - `disabled`

    La liste blanche de canal se trouve sous `channels.slack.channels`.

    Note au runtime : si `channels.slack` est complètement manquant (configuration env uniquement) et `channels.defaults.groupPolicy` n'est pas défini, le runtime se rabat sur `groupPolicy="open"` et enregistre un avertissement.

    Résolution nom/ID :

    - les entrées de liste blanche de canal et les entrées de liste blanche DM sont résolues au démarrage quand l'accès token le permet
    - les entrées non résolues sont gardées telles que configurées

  </Tab>

  <Tab title="Mentions et utilisateurs de canal">
    Les messages de canal sont protégés par mention par défaut.

    Sources de mention :

    - mention explicite de l'app (`<@botId>`)
    - modèles regex de mention (`agents.list[].groupChat.mentionPatterns`, solution de secours `messages.groupChat.mentionPatterns`)
    - comportement implicite de fil réponse-au-bot

    Contrôles par canal (`channels.slack.channels.<id|name>`) :

    - `requireMention`
    - `users` (liste blanche)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## Commandes et comportement slash

- Le mode auto de commande native est **désactivé** pour Slack (`commands.native: "auto"` n'active pas les commandes natives Slack).
- Activez les gestionnaires de commande Slack natifs avec `channels.slack.commands.native: true` (ou global `commands.native: true`).
- Quand les commandes natives sont activées, enregistrez les commandes slash correspondantes dans Slack (noms `/<command>`).
- Si les commandes natives ne sont pas activées, vous pouvez exécuter une seule commande slash configurée via `channels.slack.slashCommand`.

Paramètres de commande slash par défaut :

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

Les sessions slash utilisent des clés isolées :

- `agent:<agentId>:slack:slash:<userId>`

et routent toujours l'exécution de commande vers la session de conversation cible (`CommandTargetSessionKey`).

## Fils, sessions et tags de réponse

- Les DM routent comme `direct` ; les canaux comme `channel` ; les MPIM comme `group`.
- Avec le `session.dmScope=main` par défaut, les DM Slack se regroupent dans la session principale de l'agent.
- Sessions de canal : `agent:<agentId>:slack:channel:<channelId>`.
- Les réponses de fil peuvent créer des suffixes de session de fil (`:thread:<threadTs>`) quand applicable.
- `channels.slack.thread.historyScope` par défaut est `thread` ; `thread.inheritParent` par défaut est `false`.
- `channels.slack.thread.initialHistoryLimit` contrôle combien de messages de fil existants sont récupérés quand une nouvelle session de fil démarre (par défaut `20` ; définissez `0` pour désactiver).

Contrôles de fil de réponse :

- `channels.slack.replyToMode` : `off|first|all` (par défaut `off`)
- `channels.slack.replyToModeByChatType` : par `direct|group|channel`
- solution de secours ancienne pour les discussions directes : `channels.slack.dm.replyToMode`

Les tags de réponse manuels sont supportés :

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

Note : `replyToMode="off"` désactive le fil de réponse implicite. Les tags explicites `[[reply_to_*]]` sont toujours honorés.

## Média, découpage et livraison

<AccordionGroup>
  <Accordion title="Pièces jointes entrantes">
    Les pièces jointes de fichier Slack sont téléchargées depuis les URL privées hébergées par Slack (flux de requête authentifié par token) et écrites dans le magasin média quand la récupération réussit et que les limites de taille le permettent.

    Le plafond de taille entrante au runtime par défaut est `20MB` sauf si remplacé par `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Texte et fichiers sortants">
    - les morceaux de texte utilisent `channels.slack.textChunkLimit` (par défaut 4000)
    - `channels.slack.chunkMode="newline"` active le découpage paragraphe d'abord
    - les envois de fichier utilisent les API d'upload Slack et peuvent inclure des réponses de fil (`thread_ts`)
    - le plafond média sortant suit `channels.slack.mediaMaxMb` quand configuré ; sinon les envois de canal utilisent les valeurs par défaut par type MIME du pipeline média
  </Accordion>

  <Accordion title="Cibles de livraison">
    Cibles explicites préférées :

    - `user:<id>` pour les DM
    - `channel:<id>` pour les canaux

    Les DM Slack sont ouverts via les API de conversation Slack lors de l'envoi vers des cibles utilisateur.

  </Accordion>
</AccordionGroup>

## Actions et portes

Les actions Slack sont contrôlées par `channels.slack.actions.*`.

Groupes d'action disponibles dans l'outillage Slack actuel :

| Groupe     | Par défaut |
| ---------- | ---------- |
| messages   | activé     |
| reactions  | activé     |
| pins       | activé     |
| memberInfo | activé     |
| emojiList  | activé     |

## Événements et comportement opérationnel

- Les éditions/suppressions de message/diffusions de fil sont mappées en événements système.
- Les événements d'ajout/suppression de réaction sont mappés en événements système.
- Les événements d'adhésion/départ de membre, canal créé/renommé, et ajout/suppression d'épingle sont mappés en événements système.
- `channel_id_changed` peut migrer les clés de config de canal quand `configWrites` est activé.
- Les métadonnées de sujet/objectif de canal sont traitées comme contexte non fiable et peuvent être injectées dans le contexte de routage.

## Manifest et liste de contrôle de portée

<AccordionGroup>
  <Accordion title="Exemple de manifest d'app Slack">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Connecteur Slack pour OpenClaw"
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
        "description": "Envoyer un message à OpenClaw",
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
        "im:history",
        "mpim:history",
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

  </Accordion>

  <Accordion title="Portées de token utilisateur optionnelles (opérations de lecture)">
    Si vous configurez `channels.slack.userToken`, les portées de lecture typiques sont :

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (si vous dépendez des lectures de recherche Slack)

  </Accordion>
</AccordionGroup>

## Dépannage

<AccordionGroup>
  <Accordion title="Pas de réponses dans les canaux">
    Vérifiez, dans l'ordre :

    - `groupPolicy`
    - liste blanche de canal (`channels.slack.channels`)
    - `requireMention`
    - liste blanche `users` par canal

    Commandes utiles :

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="Messages DM ignorés">
    Vérifiez :

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (ou ancien `channels.slack.dm.policy`)
    - approbations d'appairage / entrées de liste blanche

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode ne se connecte pas">
    Validez les tokens bot + app et l'activation de Socket Mode dans les paramètres de l'app Slack.
  </Accordion>

  <Accordion title="Mode HTTP ne reçoit pas d'événements">
    Validez :

    - signing secret
    - chemin webhook
    - URL de requête Slack (Events + Interactivity + Slash Commands)
    - `webhookPath` unique par compte HTTP

  </Accordion>

  <Accordion title="Commandes native/slash ne se déclenchent pas">
    Vérifiez si vous vouliez :

    - mode de commande native (`channels.slack.commands.native: true`) avec commandes slash correspondantes enregistrées dans Slack
    - ou mode de commande slash unique (`channels.slack.slashCommand.enabled: true`)

    Vérifiez également `commands.useAccessGroups` et les listes blanches de canal/utilisateur.

  </Accordion>
</AccordionGroup>

## Pointeurs de référence de configuration

Référence principale :

- [Référence de configuration - Slack](/fr-FR/gateway/configuration-reference#slack)

  Champs Slack à fort signal :
  - mode/auth : `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
  - accès DM : `dm.enabled`, `dmPolicy`, `allowFrom` (ancien : `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
  - accès canal : `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
  - fil/historique : `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
  - livraison : `textChunkLimit`, `chunkMode`, `mediaMaxMb`
  - ops/fonctionnalités : `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## Connexe

- [Appairage](/fr-FR/channels/pairing)
- [Routage de canal](/fr-FR/channels/channel-routing)
- [Dépannage](/fr-FR/channels/troubleshooting)
- [Configuration](/fr-FR/gateway/configuration)
- [Commandes slash](/fr-FR/tools/slash-commands)
