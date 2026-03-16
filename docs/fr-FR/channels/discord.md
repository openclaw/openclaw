---
summary: "Support du bot Discord, statut, capacités et configuration"
read_when:
  - Travail sur les fonctionnalités du canal Discord
title: "Discord"
---

# Discord (Bot API)

Statut : prêt pour les DM et canaux de guilde via la passerelle Discord officielle.

<CardGroup cols={3}>
  <Card title="Appairage" icon="link" href="/fr-FR/channels/pairing">
    Les DM Discord utilisent par défaut le mode appairage.
  </Card>
  <Card title="Commandes slash" icon="terminal" href="/fr-FR/tools/slash-commands">
    Comportement des commandes natives et catalogue de commandes.
  </Card>
  <Card title="Dépannage des canaux" icon="wrench" href="/fr-FR/channels/troubleshooting">
    Diagnostics inter-canaux et flux de réparation.
  </Card>
</CardGroup>

## Configuration rapide

<Steps>
  <Step title="Créer un bot Discord et activer les intents">
    Créez une application dans le Portail Développeur Discord, ajoutez un bot, puis activez :

    - **Message Content Intent**
    - **Server Members Intent** (requis pour les listes blanches de rôles et le routage basé sur les rôles ; recommandé pour la correspondance de liste blanche nom-vers-ID)

  </Step>

  <Step title="Configurer le token">

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "VOTRE_TOKEN_BOT",
    },
  },
}
```

    Solution de secours env pour le compte par défaut :

```bash
DISCORD_BOT_TOKEN=...
```

  </Step>

  <Step title="Inviter le bot et démarrer la passerelle">
    Invitez le bot sur votre serveur avec les permissions de message.

```bash
openclaw gateway
```

  </Step>

  <Step title="Approuver le premier appairage DM">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

    Les codes d'appairage expirent après 1 heure.

  </Step>
</Steps>

<Note>
La résolution du token est consciente du compte. Les valeurs de token de config l'emportent sur la solution de secours env. `DISCORD_BOT_TOKEN` est utilisé uniquement pour le compte par défaut.
</Note>

## Modèle d'exécution

- La Passerelle possède la connexion Discord.
- Le routage de réponse est déterministe : les réponses entrantes Discord reviennent à Discord.
- Par défaut (`session.dmScope=main`), les discussions directes partagent la session principale de l'agent (`agent:main:main`).
- Les canaux de guilde sont des clés de session isolées (`agent:<agentId>:discord:channel:<channelId>`).
- Les DM de groupe sont ignorés par défaut (`channels.discord.dm.groupEnabled=false`).
- Les commandes slash natives s'exécutent dans des sessions de commande isolées (`agent:<agentId>:discord:slash:<userId>`), tout en portant `CommandTargetSessionKey` vers la session de conversation routée.

## Contrôle d'accès et routage

<Tabs>
  <Tab title="Politique DM">
    `channels.discord.dmPolicy` contrôle l'accès DM (ancien : `channels.discord.dm.policy`) :

    - `pairing` (par défaut)
    - `allowlist`
    - `open` (nécessite que `channels.discord.allowFrom` inclue `"*"` ; ancien : `channels.discord.dm.allowFrom`)
    - `disabled`

    Si la politique DM n'est pas ouverte, les utilisateurs inconnus sont bloqués (ou invités à l'appairage en mode `pairing`).

    Format de cible DM pour la livraison :

    - `user:<id>`
    - `<@id>` mention

    Les ID numériques nus sont ambigus et rejetés sauf si un type de cible utilisateur/canal explicite est fourni.

  </Tab>

  <Tab title="Politique de guilde">
    La gestion des guildes est contrôlée par `channels.discord.groupPolicy` :

    - `open`
    - `allowlist`
    - `disabled`

    La base de référence sécurisée lorsque `channels.discord` existe est `allowlist`.

    Comportement `allowlist` :

    - la guilde doit correspondre à `channels.discord.guilds` (`id` préféré, slug accepté)
    - listes blanches d'expéditeurs optionnelles : `users` (ID ou noms) et `roles` (ID de rôle uniquement) ; si l'une est configurée, les expéditeurs sont autorisés quand ils correspondent à `users` OU `roles`
    - si une guilde a `channels` configuré, les canaux non listés sont refusés
    - si une guilde n'a pas de bloc `channels`, tous les canaux de cette guilde en liste blanche sont autorisés

    Exemple :

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    Si vous définissez uniquement `DISCORD_BOT_TOKEN` et ne créez pas de bloc `channels.discord`, la solution de secours au runtime est `groupPolicy="open"` (avec un avertissement dans les logs).

  </Tab>

  <Tab title="Mentions et DM de groupe">
    Les messages de guilde sont protégés par mention par défaut.

    La détection de mention inclut :

    - mention explicite du bot
    - modèles de mention configurés (`agents.list[].groupChat.mentionPatterns`, solution de secours `messages.groupChat.mentionPatterns`)
    - comportement implicite de réponse-au-bot dans les cas pris en charge

    `requireMention` est configuré par guilde/canal (`channels.discord.guilds...`).

    DM de groupe :

    - par défaut : ignorés (`dm.groupEnabled=false`)
    - liste blanche optionnelle via `dm.groupChannels` (ID de canal ou slugs)

  </Tab>
</Tabs>

### Routage d'agent basé sur les rôles

Utilisez `bindings[].match.roles` pour router les membres de guilde Discord vers différents agents par ID de rôle. Les liaisons basées sur les rôles acceptent uniquement les ID de rôle et sont évaluées après les liaisons pair ou parent-pair et avant les liaisons guilde uniquement. Si une liaison définit également d'autres champs de correspondance (par exemple `peer` + `guildId` + `roles`), tous les champs configurés doivent correspondre.

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Configuration du Portail Développeur

<AccordionGroup>
  <Accordion title="Créer app et bot">

    1. Portail Développeur Discord -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. Copier le token du bot

  </Accordion>

  <Accordion title="Intents privilégiés">
    Dans **Bot -> Privileged Gateway Intents**, activez :

    - Message Content Intent
    - Server Members Intent (recommandé)

    L'intent de présence est optionnel et requis uniquement si vous voulez recevoir les mises à jour de présence. Définir la présence du bot (`setPresence`) ne nécessite pas d'activer les mises à jour de présence pour les membres.

  </Accordion>

  <Accordion title="Portées OAuth et permissions de base">
    Générateur d'URL OAuth :

    - portées : `bot`, `applications.commands`

    Permissions de base typiques :

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions (optionnel)

    Évitez `Administrator` sauf si explicitement nécessaire.

  </Accordion>

  <Accordion title="Copier les ID">
    Activez le Mode Développeur Discord, puis copiez :

    - ID du serveur
    - ID du canal
    - ID de l'utilisateur

    Préférez les ID numériques dans la config OpenClaw pour des audits et sondes fiables.

  </Accordion>
</AccordionGroup>

## Commandes natives et auth des commandes

- `commands.native` par défaut vaut `"auto"` et est activé pour Discord.
- Remplacement par canal : `channels.discord.commands.native`.
- `commands.native=false` efface explicitement les commandes natives Discord précédemment enregistrées.
- L'auth de commande native utilise les mêmes listes blanches/politiques Discord que la gestion normale des messages.
- Les commandes peuvent toujours être visibles dans l'UI Discord pour les utilisateurs non autorisés ; l'exécution applique toujours l'auth OpenClaw et retourne "not authorized".

Voir [Commandes slash](/fr-FR/tools/slash-commands) pour le catalogue et le comportement des commandes.

## Détails des fonctionnalités

<AccordionGroup>
  <Accordion title="Tags de réponse et réponses natives">
    Discord prend en charge les tags de réponse dans la sortie de l'agent :

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    Contrôlé par `channels.discord.replyToMode` :

    - `off` (par défaut)
    - `first`
    - `all`

    Note : `off` désactive le fil de réponse implicite. Les tags explicites `[[reply_to_*]]` sont toujours honorés.

    Les ID de message sont exposés dans le contexte/historique pour que les agents puissent cibler des messages spécifiques.

  </Accordion>

  <Accordion title="Historique, contexte et comportement de fil">
    Contexte d'historique de guilde :

    - `channels.discord.historyLimit` par défaut `20`
    - solution de secours : `messages.groupChat.historyLimit`
    - `0` désactive

    Contrôles d'historique DM :

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    Comportement de fil :

    - les fils Discord sont routés comme sessions de canal
    - les métadonnées de fil parent peuvent être utilisées pour la liaison de session parent
    - la config de fil hérite de la config de canal parent sauf si une entrée spécifique au fil existe

    Les sujets de canal sont injectés comme contexte **non fiable** (pas comme prompt système).

  </Accordion>

  <Accordion title="Notifications de réaction">
    Mode de notification de réaction par guilde :

    - `off`
    - `own` (par défaut)
    - `all`
    - `allowlist` (utilise `guilds.<id>.users`)

    Les événements de réaction sont transformés en événements système et attachés à la session Discord routée.

  </Accordion>

  <Accordion title="Écritures de config">
    Les écritures de config initiées par canal sont activées par défaut.

    Cela affecte les flux `/config set|unset` (quand les fonctionnalités de commande sont activées).

    Désactiver :

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Proxy de passerelle">
    Routez le trafic WebSocket de la passerelle Discord à travers un proxy HTTP(S) avec `channels.discord.proxy`.

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    Remplacement par compte :

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Support PluralKit">
    Activez la résolution PluralKit pour mapper les messages proxifiés à l'identité du membre du système :

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optionnel ; nécessaire pour les systèmes privés
      },
    },
  },
}
```

    Notes :

    - les listes blanches peuvent utiliser `pk:<memberId>`
    - les noms d'affichage des membres sont appariés par nom/slug
    - les recherches utilisent l'ID de message original et sont contraintes par fenêtre de temps
    - si la recherche échoue, les messages proxifiés sont traités comme messages de bot et abandonnés sauf si `allowBots=true`

  </Accordion>

  <Accordion title="Configuration de présence">
    Les mises à jour de présence sont appliquées uniquement quand vous définissez un champ de statut ou d'activité.

    Exemple de statut uniquement :

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    Exemple d'activité (le statut personnalisé est le type d'activité par défaut) :

```json5
{
  channels: {
    discord: {
      activity: "Temps de concentration",
      activityType: 4,
    },
  },
}
```

    Exemple de streaming :

```json5
{
  channels: {
    discord: {
      activity: "Codage en direct",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    Table de type d'activité :

    - 0 : Joue à
    - 1 : En streaming (nécessite `activityUrl`)
    - 2 : Écoute
    - 3 : Regarde
    - 4 : Personnalisé (utilise le texte d'activité comme état de statut ; emoji optionnel)
    - 5 : En compétition

  </Accordion>

  <Accordion title="Approbations exec dans Discord">
    Discord prend en charge les approbations exec basées sur des boutons dans les DM et peut optionnellement publier des invites d'approbation dans le canal d'origine.

    Chemin de config :

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, par défaut : `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    Quand `target` est `channel` ou `both`, l'invite d'approbation est visible dans le canal. Seuls les approbateurs configurés peuvent utiliser les boutons ; les autres utilisateurs reçoivent un refus éphémère. Les invites d'approbation incluent le texte de commande, donc activez uniquement la livraison de canal dans les canaux de confiance. Si l'ID de canal ne peut pas être dérivé de la clé de session, OpenClaw se rabat sur la livraison DM.

    Si les approbations échouent avec des ID d'approbation inconnus, vérifiez la liste des approbateurs et l'activation de la fonctionnalité.

    Docs connexes : [Approbations exec](/fr-FR/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## Outils et portes d'action

Les actions de message Discord incluent la messagerie, l'admin de canal, la modération, la présence et les actions de métadonnées.

Exemples principaux :

- messagerie : `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- réactions : `react`, `reactions`, `emojiList`
- modération : `timeout`, `kick`, `ban`
- présence : `setPresence`

Les portes d'action se trouvent sous `channels.discord.actions.*`.

Comportement de porte par défaut :

| Groupe d'action                                                                                                                                                          | Par défaut |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | activé     |
| roles                                                                                                                                                                    | désactivé  |
| moderation                                                                                                                                                               | désactivé  |
| presence                                                                                                                                                                 | désactivé  |

## Messages vocaux

Les messages vocaux Discord affichent un aperçu de forme d'onde et nécessitent de l'audio OGG/Opus plus des métadonnées. OpenClaw génère automatiquement la forme d'onde, mais nécessite que `ffmpeg` et `ffprobe` soient disponibles sur l'hôte de passerelle pour inspecter et convertir les fichiers audio.

Exigences et contraintes :

- Fournir un **chemin de fichier local** (les URL sont rejetées).
- Omettre le contenu texte (Discord ne permet pas texte + message vocal dans la même charge utile).
- Tout format audio est accepté ; OpenClaw convertit en OGG/Opus si nécessaire.

Exemple :

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## Dépannage

<AccordionGroup>
  <Accordion title="Intents non autorisés utilisés ou bot ne voit pas les messages de guilde">

    - activer Message Content Intent
    - activer Server Members Intent quand vous dépendez de la résolution utilisateur/membre
    - redémarrer la passerelle après changement d'intents

  </Accordion>

  <Accordion title="Messages de guilde bloqués de manière inattendue">

    - vérifier `groupPolicy`
    - vérifier la liste blanche de guilde sous `channels.discord.guilds`
    - si la map de guilde `channels` existe, seuls les canaux listés sont autorisés
    - vérifier le comportement `requireMention` et les modèles de mention

    Vérifications utiles :

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false mais toujours bloqué">
    Causes courantes :

    - `groupPolicy="allowlist"` sans liste blanche guilde/canal correspondante
    - `requireMention` configuré au mauvais endroit (doit être sous `channels.discord.guilds` ou entrée de canal)
    - expéditeur bloqué par liste blanche `users` de guilde/canal

  </Accordion>

  <Accordion title="Désaccords d'audit de permissions">
    Les vérifications de permission `channels status --probe` fonctionnent uniquement pour les ID de canal numériques.

    Si vous utilisez des clés slug, la correspondance au runtime peut toujours fonctionner, mais la sonde ne peut pas vérifier complètement les permissions.

  </Accordion>

  <Accordion title="Problèmes DM et d'appairage">

    - DM désactivé : `channels.discord.dm.enabled=false`
    - Politique DM désactivée : `channels.discord.dmPolicy="disabled"` (ancien : `channels.discord.dm.policy`)
    - en attente d'approbation d'appairage en mode `pairing`

  </Accordion>

  <Accordion title="Boucles bot à bot">
    Par défaut les messages créés par bot sont ignorés.

    Si vous définissez `channels.discord.allowBots=true`, utilisez des règles strictes de mention et liste blanche pour éviter le comportement de boucle.

  </Accordion>
</AccordionGroup>

## Pointeurs de référence de configuration

Référence principale :

- [Référence de configuration - Discord](/fr-FR/gateway/configuration-reference#discord)

Champs Discord à fort signal :

- démarrage/auth : `enabled`, `token`, `accounts.*`, `allowBots`
- politique : `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- commande : `commands.native`, `commands.useAccessGroups`, `configWrites`
- réponse/historique : `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- livraison : `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- média/nouvelle tentative : `mediaMaxMb`, `retry`
- actions : `actions.*`
- présence : `activity`, `status`, `activityType`, `activityUrl`
- fonctionnalités : `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## Sécurité et opérations

- Traitez les tokens de bot comme des secrets (`DISCORD_BOT_TOKEN` préféré dans les environnements supervisés).
- Accordez les permissions Discord de moindre privilège.
- Si le déploiement/état de commande est obsolète, redémarrez la passerelle et revérifiez avec `openclaw channels status --probe`.

## Connexe

- [Appairage](/fr-FR/channels/pairing)
- [Routage de canal](/fr-FR/channels/channel-routing)
- [Dépannage](/fr-FR/channels/troubleshooting)
- [Commandes slash](/fr-FR/tools/slash-commands)
