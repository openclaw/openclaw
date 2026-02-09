---
summary: "Statut de prise en charge du bot Discord, capacites et configuration"
read_when:
  - Travail sur les fonctionnalites du canal Discord
title: "Discord"
---

# Discord (API Bot)

Statut : pret pour les Messages prives et les canaux texte de guildes via la passerelle officielle de bot Discord.

## Demarrage rapide (debutant)

1. Creez un bot Discord et copiez le jeton du bot.
2. Dans les parametres de l’application Discord, activez **Message Content Intent** (et **Server Members Intent** si vous prevoyez d’utiliser des allowlists ou des recherches par nom).
3. Definissez le jeton pour OpenClaw :
   - Env : `DISCORD_BOT_TOKEN=...`
   - Ou config : `channels.discord.token: "..."`.
   - Si les deux sont definis, la config est prioritaire (le repli env est reserve au compte par defaut).
4. Invitez le bot sur votre serveur avec les permissions de message (creez un serveur prive si vous voulez uniquement des Messages prives).
5. Demarrez la Gateway (passerelle).
6. L'accès DM est appairage par défaut; approuve le code d'appairage au premier contact.

Configuration minimale :

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Objectifs

- Parler a OpenClaw via les Messages prives Discord ou les canaux de guilde.
- Les discussions directes se fondent dans la session principale de l’agent (par defaut `agent:main:main`) ; les canaux de guilde restent isoles comme `agent:<agentId>:discord:channel:<channelId>` (les noms d’affichage utilisent `discord:<guildSlug>#<channelSlug>`).
- Les Messages prives de groupe sont ignores par defaut ; activez-les via `channels.discord.dm.groupEnabled` et restreignez-les optionnellement avec `channels.discord.dm.groupChannels`.
- Conserver un routage deterministe : les reponses reviennent toujours au canal d’origine.

## Fonctionnement

1. Creez une application Discord → Bot, activez les intents necessaires (Messages prives + messages de guilde + contenu des messages), puis recuperez le jeton du bot.
2. Invitez le bot sur votre serveur avec les permissions requises pour lire/envoyer des messages la ou vous souhaitez l’utiliser.
3. Configurez OpenClaw avec `channels.discord.token` (ou `DISCORD_BOT_TOKEN` en repli).
4. Lancez la Gateway (passerelle) ; elle demarre automatiquement le canal Discord lorsqu’un jeton est disponible (config en priorite, env en repli) et que `channels.discord.enabled` n’est pas `false`.
   - Si vous preferez les variables d’environnement, definissez `DISCORD_BOT_TOKEN` (un bloc de config est optionnel).
5. Discussions directes : utilisez `user:<id>` (ou une mention `<@id>`) lors de la livraison ; tous les tours arrivent dans la session partagee `main`. Les ID numeriques seuls sont ambigus et rejetes.
6. Canaux de guilde : utilisez `channel:<channelId>` pour la livraison. Les mentions sont requises par defaut et peuvent etre definies par guilde ou par canal.
7. Discussions directes : securisees par defaut via `channels.discord.dm.policy` (defaut : `"pairing"`). Les expéditeurs inconnus recoivent un code d’appariement (expire apres 1 heure) ; approuvez via `openclaw pairing approve discord <code>`.
   - Pour conserver l’ancien comportement « ouvert a tous » : definissez `channels.discord.dm.policy="open"` et `channels.discord.dm.allowFrom=["*"]`.
   - Pour une allowlist stricte : definissez `channels.discord.dm.policy="allowlist"` et listez les expediteurs dans `channels.discord.dm.allowFrom`.
   - Pour ignorer tous les Messages prives : definissez `channels.discord.dm.enabled=false` ou `channels.discord.dm.policy="disabled"`.
8. Les Messages prives de groupe sont ignores par defaut ; activez-les via `channels.discord.dm.groupEnabled` et restreignez-les optionnellement avec `channels.discord.dm.groupChannels`.
9. Regles de guilde optionnelles : definissez `channels.discord.guilds` indexe par id de guilde (prefere) ou slug, avec des regles par canal.
10. Commandes natives optionnelles : `commands.native` vaut par defaut `"auto"` (active pour Discord/Telegram, desactive pour Slack). Remplacez avec `channels.discord.commands.native: true|false|"auto"` ; `false` efface les commandes precedemment enregistrees. Les commandes texte sont controlees par `commands.text` et doivent etre envoyees comme messages `/...` autonomes. Utilisez `commands.useAccessGroups: false` pour contourner les verifications de groupes d’acces pour les commandes.
    - Liste complete des commandes + config : [Slash commands](/tools/slash-commands)
11. Historique de contexte de guilde optionnel : definissez `channels.discord.historyLimit` (defaut 20, repli sur `messages.groupChat.historyLimit`) pour inclure les N derniers messages de guilde comme contexte lors d’une reponse a une mention. Definissez `0` pour desactiver.
12. Reactions : l’agent peut declencher des reactions via l’outil `discord` (controle par `channels.discord.actions.*`).
    - Semantique de suppression des reactions : voir [/tools/reactions](/tools/reactions).
    - L’outil `discord` n’est expose que lorsque le canal courant est Discord.
13. Les commandes natives utilisent des cles de session isolees (`agent:<agentId>:discord:slash:<userId>`) plutot que la session partagee `main`.

Remarque : la resolution nom → id utilise la recherche de membres de guilde et necessite **Server Members Intent** ; si le bot ne peut pas rechercher des membres, utilisez des id ou des mentions `<@id>`.
Remarque : les slugs sont en minuscules avec les espaces remplaces par `-`. Les noms de canaux sont slugifies sans le `#` initial.
Remarque : les lignes de contexte de guilde `[from:]` incluent `author.tag` + `id` pour faciliter des reponses prêtes au ping.

## Ecritures de configuration

Par defaut, Discord est autorise a ecrire des mises a jour de configuration declenchees par `/config set|unset` (necessite `commands.config: true`).

Desactivez avec :

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Comment creer votre propre bot

Il s’agit de la configuration du « Discord Developer Portal » pour executer OpenClaw dans un canal de serveur (guilde) comme `#help`.

### 1. Creer l’application Discord + l’utilisateur bot

1. Discord Developer Portal → **Applications** → **New Application**
2. Dans votre application :
   - **Bot** → **Add Bot**
   - Copiez le **Bot Token** (c’est ce que vous mettez dans `DISCORD_BOT_TOKEN`)

### 2) Activer les intents de passerelle necessaires a OpenClaw

Discord bloque les « privileged intents » a moins de les activer explicitement.

Dans **Bot** → **Privileged Gateway Intents**, activez :

- **Message Content Intent** (requis pour lire le texte des messages dans la plupart des guildes ; sans lui vous verrez « Used disallowed intents » ou le bot se connectera sans reagir aux messages)
- **Server Members Intent** (recommande ; requis pour certaines recherches de membres/utilisateurs et la correspondance des allowlists dans les guildes)

Vous n’avez generalement **pas** besoin de **Presence Intent**. Definir la presence du bot (action `setPresence`) utilise l’OP3 de la passerelle et ne requiert pas cet intent ; il n’est necessaire que si vous souhaitez recevoir des mises a jour de presence d’autres membres de guilde.

### 3. Generer une URL d’invitation (OAuth2 URL Generator)

Dans votre application : **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (requis pour les commandes natives)

**Bot Permissions** (base minimale)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (optionnel mais recommande)
- ✅ Use External Emojis / Stickers (optionnel ; seulement si vous les voulez)

Evitez **Administrator** sauf pour le debogage et si vous faites entierement confiance au bot.

Copiez l’URL generee, ouvrez-la, choisissez votre serveur et installez le bot.

### 4. Recuperer les id (guilde/utilisateur/canal)

Discord utilise des id numeriques partout ; la config OpenClaw prefere les id.

1. Discord (bureau/web) → **User Settings** → **Advanced** → activez **Developer Mode**
2. Clic droit :
   - Nom du serveur → **Copy Server ID** (id de guilde)
   - `#help`) → **Copy Channel ID**
   - Votre utilisateur → **Copy User ID**

### 5) Configurer OpenClaw

#### Jeton

Definissez le jeton du bot via variable d’environnement (recommande sur les serveurs) :

- `DISCORD_BOT_TOKEN=...`

Ou via la config :

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Prise en charge multi-comptes : utilisez `channels.discord.accounts` avec des jetons par compte et `name` optionnel. Voir [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) pour le modele partage.

#### Allowlist + routage des canaux

Exemple « un seul serveur, m’autoriser uniquement, autoriser seulement #help » :

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Notes :

- `requireMention: true` signifie que le bot ne repond que lorsqu’il est mentionne (recommande pour les canaux partages).
- `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) comptent aussi comme des mentions pour les messages de guilde.
- Surcharge multi-agent : definissez des motifs par agent sur `agents.list[].groupChat.mentionPatterns`.
- Si `channels` est present, tout canal non liste est refuse par defaut.
- Utilisez une entree de canal `"*"` pour appliquer des valeurs par defaut a tous les canaux ; les entrees explicites de canal remplacent le joker.
- Les fils (threads) heritent de la config du canal parent (allowlist, `requireMention`, skills, prompts, etc.) sauf si vous ajoutez explicitement l’id du canal du fil.
- Indice proprietaire : lorsqu’une allowlist `users` par guilde ou par canal correspond a l’expediteur, OpenClaw traite cet expediteur comme proprietaire dans le prompt systeme. Pour un proprietaire global entre canaux, definissez `commands.ownerAllowFrom`.
- Les messages rediges par des bots sont ignores par defaut ; definissez `channels.discord.allowBots=true` pour les autoriser (vos propres messages restent filtres).
- Avertissement : si vous autorisez les reponses a d’autres bots (`channels.discord.allowBots=true`), evitez les boucles bot-a-bot avec des allowlists `requireMention`, `channels.discord.guilds.*.channels.<id>.users` et/ou des garde-fous clairs dans `AGENTS.md` et `SOUL.md`.

### 6. Verifier le fonctionnement

1. Demarrez la Gateway (passerelle).
2. Dans votre canal de serveur, envoyez : `@Krill hello` (ou quel que soit le nom de votre bot).
3. Si rien ne se passe : consultez **Depannage** ci-dessous.

### Problemes courants

- D’abord : lancez `openclaw doctor` et `openclaw channels status --probe` (avertissements actionnables + audits rapides).
- **« Used disallowed intents »** : activez **Message Content Intent** (et probablement **Server Members Intent**) dans le Developer Portal, puis redemarrez la Gateway (passerelle).
- **Le bot se connecte mais ne repond jamais dans un canal de guilde** :
  - **Message Content Intent** manquant, ou
  - Le bot n’a pas les permissions du canal (View/Send/Read History), ou
  - Votre config exige des mentions et vous ne l’avez pas mentionne, ou
  - Votre allowlist de guilde/canal refuse le canal/l’utilisateur.
- **`requireMention: false` mais toujours aucune reponse** :
- `channels.discord.groupPolicy` est par defaut sur **allowlist** ; definissez-le sur `"open"` ou ajoutez une entree de guilde sous `channels.discord.guilds` (listez optionnellement les canaux sous `channels.discord.guilds.<id>.channels` pour restreindre).
  - Si vous ne definissez que `DISCORD_BOT_TOKEN` et ne creez jamais de section `channels.discord`, le runtime
    met `groupPolicy` par defaut a `open`. Ajoutez `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, ou une allowlist de guilde/canal pour verrouiller.
- `requireMention` doit se trouver sous `channels.discord.guilds` (ou un canal specifique). `channels.discord.requireMention` au niveau racine est ignore.
- **Audits de permissions** (`channels status --probe`) ne verifient que les ID numeriques de canal. Si vous utilisez des slugs/noms comme cles `channels.discord.guilds.*.channels`, l’audit ne peut pas verifier les permissions.
- **Les Messages prives ne fonctionnent pas** : `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, ou vous n’avez pas encore ete approuve (`channels.discord.dm.policy="pairing"`).
- **Approbations d’exec dans Discord** : Discord prend en charge une **interface a boutons** pour les approbations d’exec en Messages prives (Autoriser une fois / Toujours autoriser / Refuser). `/approve <id> ...` est reserve aux approbations transferees et ne resoudra pas les invites a boutons de Discord. Si vous voyez `❌ Failed to submit approval: Error: unknown approval id` ou si l’UI n’apparait jamais, verifiez :
  - `channels.discord.execApprovals.enabled: true` dans votre config.
  - Que votre ID utilisateur Discord figure dans `channels.discord.execApprovals.approvers` (l’UI n’est envoyee qu’aux approbateurs).
  - Utilisez les boutons dans l'invite de MP (**Autoriser une fois**, **Toujours autoriser**, **Refuser**).
  - Voir [Exec approvals](/tools/exec-approvals) et [Slash commands](/tools/slash-commands) pour le flux global d’approbations et de commandes.

## Capacites et limites

- Messages prives et canaux texte de guilde (les fils sont traites comme des canaux distincts ; la voix n’est pas prise en charge).
- Indicateurs de frappe envoyes au mieux ; le decoupage des messages utilise `channels.discord.textChunkLimit` (defaut 2000) et separe les longues reponses par nombre de lignes (`channels.discord.maxLinesPerMessage`, defaut 17).
- Decoupage optionnel par nouvelle ligne : definissez `channels.discord.chunkMode="newline"` pour decouper sur les lignes vides (limites de paragraphes) avant le decoupage par longueur.
- Televersements de fichiers pris en charge jusqu’a la valeur configuree `channels.discord.mediaMaxMb` (defaut 8 Mo).
- Reponses de guilde conditionnees par mention par defaut pour eviter les bots bruyants.
- Le contexte de reponse est injecte lorsqu’un message reference un autre message (contenu cite + id).
- Le fil de reponse natif est **desactive par defaut** ; activez-le avec `channels.discord.replyToMode` et des balises de reponse.

## Politique de nouvelle tentative

Les appels sortants a l’API Discord reessaient en cas de limitation de debit (429) en utilisant `retry_after` de Discord lorsque disponible, avec backoff exponentiel et jitter. Configurez via `channels.discord.retry`. Voir [Retry policy](/concepts/retry).

## Configuration

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Les reactions d’accuse de reception sont controlees globalement via `messages.ackReaction` +
`messages.ackReactionScope`. Utilisez `messages.removeAckAfterReply` pour effacer la reaction
d’accuse apres la reponse du bot.

- `dm.enabled` : definissez `false` pour ignorer tous les Messages prives (defaut `true`).
- `dm.policy` : controle d’acces aux Messages prives (`pairing` recommande). `"open"` requiert `dm.allowFrom=["*"]`.
- `dm.allowFrom` : allowlist des Messages prives (id utilisateurs ou noms). Utilisee par `dm.policy="allowlist"` et pour la validation `dm.policy="open"`. L’assistant accepte les noms d’utilisateur et les resout en id lorsque le bot peut rechercher des membres.
- `dm.groupEnabled` : activer les Messages prives de groupe (defaut `false`).
- `dm.groupChannels` : allowlist optionnelle pour les id ou slugs de canaux de Messages prives de groupe.
- `groupPolicy` : controle la gestion des canaux de guilde (`open|disabled|allowlist`) ; `allowlist` requiert des allowlists de canaux.
- `guilds` : regles par guilde indexees par id de guilde (prefere) ou slug.
- `guilds."*"` : parametres par defaut par guilde appliques lorsqu’aucune entree explicite n’existe.
- `guilds.<id>.slug` : slug convivial optionnel utilise pour les noms d’affichage.
- `guilds.<id>.users` : allowlist utilisateur optionnelle par guilde (id ou noms).
- `guilds.<id>.tools` : surcharges optionnelles de politique d’outils par guilde (`allow`/`deny`/`alsoAllow`) utilisees lorsque la surcharge de canal est absente.
- `guilds.<id>.toolsBySender` : surcharges optionnelles de politique d’outils par expediteur au niveau de la guilde (s’applique lorsque la surcharge de canal est absente ; joker `"*"` pris en charge).
- `guilds.<id>.channels.<channel>.allow` : autoriser/refuser le canal lorsque `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention` : conditionnement par mention pour le canal.
- `guilds.<id>.channels.<channel>.tools` : surcharges optionnelles de politique d’outils par canal (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender` : surcharges optionnelles de politique d’outils par expediteur dans le canal (joker `"*"` pris en charge).
- `guilds.<id>.channels.<channel>.users` : allowlist utilisateur optionnelle par canal.
- `guilds.<id>.channels.<channel>.skills` : filtre de skill (omis = tous les Skills, vide = aucun).
- `guilds.<id>.channels.<channel>.systemPrompt` : prompt systeme supplementaire pour le canal. Les sujets de canal Discord sont injectes comme contexte **non fiable** (pas comme prompt systeme).
- `guilds.<id>.channels.<channel>.enabled` : definissez `false` pour desactiver le canal.
- `guilds.<id>.channels` : regles de canal (cles = slugs ou id de canaux).
- `guilds.<id>.requireMention` : exigence de mention par guilde (remplacable par canal).
- `guilds.<id>.reactionNotifications` : mode d’evenement du systeme de reactions (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit` : taille de decoupage du texte sortant (caracteres). Defaut : 2000.
- `chunkMode` : `length` (defaut) ne decoupe que lorsque `textChunkLimit` est depasse ; `newline` decoupe sur les lignes vides (limites de paragraphes) avant le decoupage par longueur.
- `maxLinesPerMessage` : nombre maximal souple de lignes par message. Defaut : 17.
- `mediaMaxMb` : plafonner les medias entrants sauvegardes sur disque.
- `historyLimit` : nombre de messages recents de guilde a inclure comme contexte lors d’une reponse a une mention (defaut 20 ; repli sur `messages.groupChat.historyLimit` ; `0` desactive).
- `dmHistoryLimit` : limite d’historique des Messages prives en tours utilisateur. Surcharges par utilisateur : `dms["<user_id>"].historyLimit`.
- `retry` : politique de nouvelle tentative pour les appels sortants a l’API Discord (tentatives, minDelayMs, maxDelayMs, jitter).
- `pluralkit` : resoudre les messages proxifies par PluralKit afin que les membres du systeme apparaissent comme expediteurs distincts.
- `actions` : garde-fous d’outils par action ; omettre pour autoriser tout (definir `false` pour desactiver).
  - `reactions` (couvre react + lecture des reactions)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (creer/modifier/supprimer canaux + categories + permissions)
  - `roles` (ajout/suppression de roles, defaut `false`)
  - `moderation` (timeout/expulsion/bannissement, defaut `false`)
  - `presence` (statut/activite du bot, defaut `false`)
- `execApprovals` : Messages prives d’approbation d’exec propres a Discord (UI a boutons). Prend en charge `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Les notifications de reactions utilisent `guilds.<id>.reactionNotifications` :

- `off` : aucun evenement de reaction.
- `own` : reactions sur les propres messages du bot (defaut).
- `all` : toutes les reactions sur tous les messages.
- `allowlist` : reactions provenant de `guilds.<id>.users` sur tous les messages (liste vide desactive).

### Prise en charge de PluralKit (PK)

Activez les recherches PK afin que les messages proxifies se resolvent vers le systeme + membre sous-jacent.
Lorsqu’active, OpenClaw utilise l’identite du membre pour les allowlists et libelle
l’expediteur comme `Member (PK:System)` afin d’eviter les pings Discord accidentels.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Notes sur les allowlists (PK active) :

- Utilisez `pk:<memberId>` dans `dm.allowFrom`, `guilds.<id>.users`, ou par canal `users`.
- Les noms d’affichage des membres sont aussi compares par nom/slug.
- Les recherches utilisent l’ID du message Discord **original** (avant proxy), de sorte que
  l’API PK ne le resout que dans sa fenetre de 30 minutes.
- Si les recherches PK echouent (par ex., systeme prive sans jeton), les messages proxifies
  sont traites comme des messages de bot et sont ignores sauf si `channels.discord.allowBots=true`.

### Action par défaut de l'outil

| Groupe d’actions | Par défaut | Notes                                                            |
| ---------------- | ---------- | ---------------------------------------------------------------- |
| reactions        | active     | React + lister reactions + emojiList                             |
| stickers         | active     | Envoyer des stickers                                             |
| emojiUploads     | active     | Televerser des emojis                                            |
| stickerUploads   | active     | Televerser des stickers                                          |
| polls            | active     | Creer des sondages                                               |
| permissions      | active     | Instantane des permissions de canal                              |
| messages         | active     | Lire/envoyer/modifier/supprimer                                  |
| threads          | active     | Creer/lister/repondre                                            |
| pins             | active     | Epingler/retirer/lister                                          |
| search           | active     | Recherche de messages (fonctionnalite apercu) |
| memberInfo       | active     | Infos membre                                                     |
| roleInfo         | active     | Liste des roles                                                  |
| channelInfo      | active     | Infos canal + liste                                              |
| channels         | active     | Gestion canaux/categories                                        |
| voiceStatus      | active     | Recherche d'état vocal                                           |
| events           | active     | Lister/creer des evenements programmes                           |
| roles            | desactive  | Ajout/suppression de roles                                       |
| moderation       | desactive  | Timeout/expulsion/bannissement                                   |
| presence         | desactive  | Statut/activite du bot (setPresence)          |

- `replyToMode` : `off` (defaut), `first`, ou `all`. S’applique uniquement lorsque le modele inclut une balise de reponse.

## Balises de reponse

Pour demander une reponse en fil, le modele peut inclure une balise dans sa sortie :

- `[[reply_to_current]]` — repondre au message Discord declencheur.
- `[[reply_to:<id>]]` — repondre a un id de message specifique depuis le contexte/historique.
  Les id de messages courants sont ajoutes aux prompts comme `[message_id: …]` ; les entrees d’historique incluent deja des id.

Le comportement est controle par `channels.discord.replyToMode` :

- `off` : ignorer les balises.
- `first` : seul le premier bloc sortant/piece jointe est une reponse.
- `all` : chaque bloc sortant/piece jointe est une reponse.

Notes sur la correspondance des allowlists :

- `allowFrom`/`users`/`groupChannels` acceptent des id, noms, balises ou mentions comme `<@id>`.
- Les prefixes comme `discord:`/`user:` (utilisateurs) et `channel:` (Messages prives de groupe) sont pris en charge.
- Utilisez `*` pour autoriser n’importe quel expediteur/canal.
- Lorsque `guilds.<id>.channels` est present, les canaux non listes sont refuses par defaut.
- Lorsque `guilds.<id>.channels` est omis, tous les canaux de la guilde autorisee sont permis.
- Pour n’autoriser **aucun canal**, definissez `channels.discord.groupPolicy: "disabled"` (ou conservez une allowlist vide).
- L’assistant de configuration accepte les noms `Guild/Channel` (publics + prives) et les resout en ID lorsque possible.
- Au demarrage, OpenClaw resout les noms de canaux/utilisateurs des allowlists en ID (lorsque le bot peut rechercher des membres)
  et journalise la correspondance ; les entrees non resolues sont conservees telles quelles.

Notes sur les commandes natives :

- Les commandes enregistrees reflètent les commandes de chat d’OpenClaw.
- Les commandes natives respectent les memes allowlists que les Messages prives/messages de guilde (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, regles par canal).
- Les slash commands peuvent rester visibles dans l’UI Discord pour des utilisateurs non autorises ; OpenClaw applique les allowlists a l’execution et repond « not authorized ».

## Actions d’outils

L’agent peut appeler `discord` avec des actions telles que :

- `react` / `reactions` (ajouter ou lister des reactions)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Les charges utiles lire/rechercher/epingler incluent des `timestampMs` normalises (epoch ms UTC) et `timestampUtc` aux cotes des `timestamp` Discord bruts.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (activite du bot et statut en ligne)

Les id de messages Discord sont exposes dans le contexte injecte (`[discord message id: …]` et les lignes d’historique) afin que l’agent puisse les cibler.
Les emojis peuvent etre unicode (par ex., `✅`) ou utiliser la syntaxe d’emoji personnalise comme `<:party_blob:1234567890>`.

## Securite et exploitation

- Traitez le jeton du bot comme un mot de passe ; privilegiez la variable d’environnement `DISCORD_BOT_TOKEN` sur des hôtes supervises ou verrouillez les permissions du fichier de configuration.
- N’accordez au bot que les permissions necessaires (generalement Lire/Envoyer des messages).
- Si le bot est bloque ou limite par le debit, redemarrez la Gateway (passerelle) (`openclaw gateway --force`) apres avoir confirme qu’aucun autre processus ne detient la session Discord.
