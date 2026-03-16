---
summary: "Support du bot Telegram, statut, capacités et configuration"
read_when:
  - Travail sur les fonctionnalités Telegram ou les webhooks
title: "Telegram"
---

# Telegram (Bot API)

Statut : prêt pour la production pour les DM et groupes de bot via grammY. Le long polling est le mode par défaut ; le mode webhook est optionnel.

<CardGroup cols={3}>
  <Card title="Appairage" icon="link" href="/fr-FR/channels/pairing">
    La politique DM par défaut pour Telegram est l'appairage.
  </Card>
  <Card title="Dépannage des canaux" icon="wrench" href="/fr-FR/channels/troubleshooting">
    Diagnostics inter-canaux et procédures de réparation.
  </Card>
  <Card title="Configuration de la Passerelle" icon="settings" href="/fr-FR/gateway/configuration">
    Modèles et exemples de configuration des canaux complets.
  </Card>
</CardGroup>

## Configuration rapide

<Steps>
  <Step title="Créer le token du bot dans BotFather">
    Ouvrez Telegram et discutez avec **@BotFather** (vérifiez que le handle est exactement `@BotFather`).

    Exécutez `/newbot`, suivez les instructions et sauvegardez le token.

  </Step>

  <Step title="Configurer le token et la politique DM">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    Solution de secours env : `TELEGRAM_BOT_TOKEN=...` (compte par défaut uniquement).

  </Step>

  <Step title="Démarrer la passerelle et approuver le premier DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    Les codes d'appairage expirent après 1 heure.

  </Step>

  <Step title="Ajouter le bot à un groupe">
    Ajoutez le bot à votre groupe, puis configurez `channels.telegram.groups` et `groupPolicy` selon votre modèle d'accès.
  </Step>
</Steps>

<Note>
L'ordre de résolution du token est conscient du compte. En pratique, les valeurs de config l'emportent sur la solution de secours env, et `TELEGRAM_BOT_TOKEN` s'applique uniquement au compte par défaut.
</Note>

## Paramètres côté Telegram

<AccordionGroup>
  <Accordion title="Mode confidentialité et visibilité de groupe">
    Les bots Telegram utilisent par défaut le **Mode confidentialité**, qui limite les messages de groupe qu'ils reçoivent.

    Si le bot doit voir tous les messages du groupe, soit :

    - désactiver le mode confidentialité via `/setprivacy`, ou
    - faire du bot un administrateur du groupe.

    Lors du basculement du mode confidentialité, retirez + réajoutez le bot dans chaque groupe pour que Telegram applique le changement.

  </Accordion>

  <Accordion title="Permissions de groupe">
    Le statut d'administrateur est contrôlé dans les paramètres du groupe Telegram.

    Les bots administrateurs reçoivent tous les messages du groupe, ce qui est utile pour un comportement de groupe always-on.

  </Accordion>

  <Accordion title="Bascules utiles de BotFather">

    - `/setjoingroups` pour autoriser/interdire les ajouts de groupe
    - `/setprivacy` pour le comportement de visibilité de groupe

  </Accordion>
</AccordionGroup>

## Contrôle d'accès et activation

<Tabs>
  <Tab title="Politique DM">
    `channels.telegram.dmPolicy` contrôle l'accès aux messages directs :

    - `pairing` (par défaut)
    - `allowlist`
    - `open` (nécessite que `allowFrom` inclue `"*"`)
    - `disabled`

    `channels.telegram.allowFrom` accepte les ID utilisateur numériques Telegram. Les préfixes `telegram:` / `tg:` sont acceptés et normalisés.
    L'assistant d'intégration accepte l'entrée `@username` et la résout en ID numériques.
    Si vous avez mis à niveau et que votre config contient des entrées de liste blanche `@username`, exécutez `openclaw doctor --fix` pour les résoudre (meilleur effort ; nécessite un token de bot Telegram).

    ### Trouver votre ID utilisateur Telegram

    Plus sûr (pas de bot tiers) :

    1. Envoyez un DM à votre bot.
    2. Exécutez `openclaw logs --follow`.
    3. Lisez `from.id`.

    Méthode officielle Bot API :

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    Méthode tierce (moins privée) : `@userinfobot` ou `@getidsbot`.

  </Tab>

  <Tab title="Politique de groupe et listes blanches">
    Il existe deux contrôles indépendants :

    1. **Quels groupes sont autorisés** (`channels.telegram.groups`)
       - pas de config `groups` : tous les groupes autorisés
       - `groups` configuré : agit comme liste blanche (ID explicites ou `"*"`)

    2. **Quels expéditeurs sont autorisés dans les groupes** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (par défaut)
       - `disabled`

    `groupAllowFrom` est utilisé pour le filtrage des expéditeurs de groupe. S'il n'est pas défini, Telegram se rabat sur `allowFrom`.
    Les entrées `groupAllowFrom` doivent être des ID utilisateur numériques Telegram.

    Exemple : autoriser tout membre dans un groupe spécifique :

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

  </Tab>

  <Tab title="Comportement de mention">
    Les réponses de groupe nécessitent une mention par défaut.

    La mention peut provenir de :

    - mention native `@botusername`, ou
    - modèles de mention dans :
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    Bascules de commande au niveau de la session :

    - `/activation always`
    - `/activation mention`

    Celles-ci mettent à jour uniquement l'état de la session. Utilisez la config pour la persistance.

    Exemple de config persistante :

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    Obtenir l'ID de discussion de groupe :

    - transférer un message de groupe à `@userinfobot` / `@getidsbot`
    - ou lire `chat.id` depuis `openclaw logs --follow`
    - ou inspecter Bot API `getUpdates`

  </Tab>
</Tabs>

## Comportement au runtime

- Telegram est détenu par le processus de passerelle.
- Le routage est déterministe : les réponses entrantes Telegram reviennent à Telegram (le modèle ne choisit pas les canaux).
- Les messages entrants se normalisent dans l'enveloppe de canal partagée avec métadonnées de réponse et espaces réservés média.
- Les sessions de groupe sont isolées par ID de groupe. Les sujets de forum ajoutent `:topic:<threadId>` pour garder les sujets isolés.
- Les messages DM peuvent porter `message_thread_id` ; OpenClaw les route avec des clés de session conscientes du fil et préserve l'ID de fil pour les réponses.
- Le long polling utilise grammY runner avec séquençage par discussion/fil. La concurrence globale du sink du runner utilise `agents.defaults.maxConcurrent`.
- Telegram Bot API n'a pas de support d'accusé de lecture (`sendReadReceipts` ne s'applique pas).

## Référence des fonctionnalités

<AccordionGroup>
  <Accordion title="Streaming de brouillon dans les DM Telegram">
    OpenClaw peut diffuser des réponses partielles avec des bulles de brouillon Telegram (`sendMessageDraft`).

    Exigences :

    - `channels.telegram.streamMode` n'est pas `"off"` (par défaut : `"partial"`)
    - discussion privée
    - mise à jour entrante inclut `message_thread_id`
    - les sujets de bot sont activés (`getMe().has_topics_enabled`)

    Modes :

    - `off` : pas de streaming de brouillon
    - `partial` : mises à jour fréquentes de brouillon à partir de texte partiel
    - `block` : mises à jour de brouillon par morceaux utilisant `channels.telegram.draftChunk`

    Valeurs par défaut `draftChunk` pour le mode bloc :

    - `minChars: 200`
    - `maxChars: 800`
    - `breakPreference: "paragraph"`

    `maxChars` est plafonné par `channels.telegram.textChunkLimit`.

    Le streaming de brouillon est DM uniquement ; les groupes/canaux n'utilisent pas de bulles de brouillon.

    Si vous voulez des messages Telegram réels précoces au lieu de mises à jour de brouillon, utilisez le streaming par blocs (`channels.telegram.blockStreaming: true`).

    Flux de raisonnement Telegram uniquement :

    - `/reasoning stream` envoie le raisonnement à la bulle de brouillon pendant la génération
    - la réponse finale est envoyée sans texte de raisonnement

  </Accordion>

  <Accordion title="Formatage et solution de secours HTML">
    Le texte sortant utilise Telegram `parse_mode: "HTML"`.

    - Le texte de type Markdown est rendu en HTML sécurisé pour Telegram.
    - Le HTML brut du modèle est échappé pour réduire les échecs d'analyse Telegram.
    - Si Telegram rejette le HTML analysé, OpenClaw réessaye en texte brut.

    Les aperçus de lien sont activés par défaut et peuvent être désactivés avec `channels.telegram.linkPreview: false`.

  </Accordion>

  <Accordion title="Commandes natives et commandes personnalisées">
    L'enregistrement du menu de commande Telegram est géré au démarrage avec `setMyCommands`.

    Valeurs par défaut des commandes natives :

    - `commands.native: "auto"` active les commandes natives pour Telegram

    Ajouter des entrées de menu de commande personnalisées :

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Sauvegarde Git" },
        { command: "generate", description: "Créer une image" },
      ],
    },
  },
}
```

    Règles :

    - les noms sont normalisés (retirer le `/` de tête, minuscules)
    - modèle valide : `a-z`, `0-9`, `_`, longueur `1..32`
    - les commandes personnalisées ne peuvent pas remplacer les commandes natives
    - les conflits/doublons sont ignorés et enregistrés

    Notes :

    - les commandes personnalisées sont uniquement des entrées de menu ; elles n'implémentent pas automatiquement de comportement
    - les commandes de plugin/compétence peuvent toujours fonctionner lorsqu'elles sont tapées même si elles ne sont pas affichées dans le menu Telegram

    Si les commandes natives sont désactivées, les intégrées sont retirées. Les commandes personnalisées/plugin peuvent toujours s'enregistrer si configurées.

    Échec de configuration courant :

    - `setMyCommands failed` signifie généralement que le DNS/HTTPS sortant vers `api.telegram.org` est bloqué.

    ### Commandes d'appairage d'appareil (plugin `device-pair`)

    Lorsque le plugin `device-pair` est installé :

    1. `/pair` génère le code de configuration
    2. collez le code dans l'app iOS
    3. `/pair approve` approuve la dernière demande en attente

    Plus de détails : [Appairage](/fr-FR/channels/pairing#pair-via-telegram-recommended-for-ios).

  </Accordion>

  <Accordion title="Boutons en ligne">
    Configurer la portée du clavier en ligne :

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    Remplacement par compte :

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    Portées :

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist` (par défaut)

    L'ancien `capabilities: ["inlineButtons"]` se mappe à `inlineButtons: "all"`.

    Exemple d'action de message :

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choisissez une option :",
  buttons: [
    [
      { text: "Oui", callback_data: "yes" },
      { text: "Non", callback_data: "no" },
    ],
    [{ text: "Annuler", callback_data: "cancel" }],
  ],
}
```

    Les clics de callback sont transmis à l'agent comme texte :
    `callback_data: <valeur>`

  </Accordion>

  <Accordion title="Actions de message Telegram pour les agents et l'automation">
    Les actions d'outil Telegram incluent :

    - `sendMessage` (`to`, `content`, `mediaUrl` optionnel, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)

    Les actions de message de canal exposent des alias ergonomiques (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`).

    Contrôles de porte :

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.editMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (par défaut : désactivé)

    Sémantique de suppression de réaction : [/tools/reactions](/fr-FR/tools/reactions)

  </Accordion>

  <Accordion title="Tags de fil de réponse">
    Telegram prend en charge les tags explicites de fil de réponse dans la sortie générée :

    - `[[reply_to_current]]` répond au message déclencheur
    - `[[reply_to:<id>]]` répond à un ID de message Telegram spécifique

    `channels.telegram.replyToMode` contrôle la gestion :

    - `off` (par défaut)
    - `first`
    - `all`

    Note : `off` désactive le fil de réponse implicite. Les tags explicites `[[reply_to_*]]` sont toujours honorés.

  </Accordion>

  <Accordion title="Sujets de forum et comportement de fil">
    Supergroupes de forum :

    - les clés de session de sujet ajoutent `:topic:<threadId>`
    - les réponses et la saisie ciblent le fil de sujet
    - chemin de config de sujet :
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    Cas spécial du sujet général (`threadId=1`) :

    - les envois de message omettent `message_thread_id` (Telegram rejette `sendMessage(...thread_id=1)`)
    - les actions de saisie incluent toujours `message_thread_id`

    Héritage de sujet : les entrées de sujet héritent des paramètres de groupe sauf si remplacés (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`).

    Le contexte de modèle inclut :

    - `MessageThreadId`
    - `IsForum`

    Comportement de fil DM :

    - les discussions privées avec `message_thread_id` gardent le routage DM mais utilisent des clés de session/cibles de réponse conscientes du fil.

  </Accordion>

  <Accordion title="Audio, vidéo et stickers">
    ### Messages audio

    Telegram distingue les notes vocales des fichiers audio.

    - par défaut : comportement de fichier audio
    - tag `[[audio_as_voice]]` dans la réponse de l'agent pour forcer l'envoi en note vocale

    Exemple d'action de message :

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### Messages vidéo

    Telegram distingue les fichiers vidéo des notes vidéo.

    Exemple d'action de message :

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    Les notes vidéo ne supportent pas les légendes ; le texte de message fourni est envoyé séparément.

    ### Stickers

    Gestion des stickers entrants :

    - WEBP statique : téléchargé et traité (espace réservé `<media:sticker>`)
    - TGS animé : ignoré
    - WEBM vidéo : ignoré

    Champs de contexte de sticker :

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    Fichier de cache de sticker :

    - `~/.openclaw/telegram/sticker-cache.json`

    Les stickers sont décrits une fois (quand possible) et mis en cache pour réduire les appels de vision répétés.

    Activer les actions de sticker :

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    Action d'envoi de sticker :

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    Rechercher des stickers en cache :

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="Notifications de réaction">
    Les réactions Telegram arrivent comme mises à jour `message_reaction` (séparées des charges utiles de message).

    Lorsqu'elles sont activées, OpenClaw met en file d'attente des événements système comme :

    - `Réaction Telegram ajoutée : 👍 par Alice (@alice) sur msg 42`

    Config :

    - `channels.telegram.reactionNotifications` : `off | own | all` (par défaut : `own`)
    - `channels.telegram.reactionLevel` : `off | ack | minimal | extensive` (par défaut : `minimal`)

    Notes :

    - `own` signifie réactions utilisateur uniquement aux messages envoyés par le bot (meilleur effort via cache de messages envoyés).
    - Telegram ne fournit pas d'ID de fil dans les mises à jour de réaction.
      - les groupes non-forum routent vers la session de discussion de groupe
      - les groupes de forum routent vers la session de sujet général du groupe (`:topic:1`), pas le sujet d'origine exact

    `allowed_updates` pour polling/webhook incluent `message_reaction` automatiquement.

  </Accordion>

  <Accordion title="Écritures de config à partir d'événements et commandes Telegram">
    Les écritures de config de canal sont activées par défaut (`configWrites !== false`).

    Les écritures déclenchées par Telegram incluent :

    - événements de migration de groupe (`migrate_to_chat_id`) pour mettre à jour `channels.telegram.groups`
    - `/config set` et `/config unset` (nécessite l'activation de commande)

    Désactiver :

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Long polling vs webhook">
    Par défaut : long polling.

    Mode webhook :

    - définir `channels.telegram.webhookUrl`
    - définir `channels.telegram.webhookSecret` (requis quand l'URL webhook est définie)
    - `channels.telegram.webhookPath` optionnel (par défaut `/telegram-webhook`)
    - `channels.telegram.webhookHost` optionnel (par défaut `127.0.0.1`)

    Le listener local par défaut pour le mode webhook se lie à `127.0.0.1:8787`.

    Si votre point de terminaison public diffère, placez un proxy inverse devant et pointez `webhookUrl` vers l'URL publique.
    Définissez `webhookHost` (par exemple `0.0.0.0`) quand vous avez intentionnellement besoin d'une entrée externe.

  </Accordion>

  <Accordion title="Limites, nouvelle tentative et cibles CLI">
    - `channels.telegram.textChunkLimit` par défaut est 4000.
    - `channels.telegram.chunkMode="newline"` préfère les limites de paragraphe (lignes vides) avant le découpage par longueur.
    - `channels.telegram.mediaMaxMb` (par défaut 5) plafonne la taille de téléchargement/traitement média entrant Telegram.
    - `channels.telegram.timeoutSeconds` remplace le timeout du client Telegram API (si non défini, la valeur par défaut grammY s'applique).
    - l'historique de contexte de groupe utilise `channels.telegram.historyLimit` ou `messages.groupChat.historyLimit` (par défaut 50) ; `0` désactive.
    - contrôles d'historique DM :
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - les nouvelles tentatives Telegram API sortantes sont configurables via `channels.telegram.retry`.

    La cible d'envoi CLI peut être un ID de discussion numérique ou un nom d'utilisateur :

```bash
openclaw message send --channel telegram --target 123456789 --message "salut"
openclaw message send --channel telegram --target @nom --message "salut"
```

  </Accordion>
</AccordionGroup>

## Dépannage

<AccordionGroup>
  <Accordion title="Le bot ne répond pas aux messages de groupe sans mention">

    - Si `requireMention=false`, le mode confidentialité Telegram doit autoriser une visibilité complète.
      - BotFather : `/setprivacy` -> Désactiver
      - puis retirer + réajouter le bot au groupe
    - `openclaw channels status` avertit quand la config attend des messages de groupe sans mention.
    - `openclaw channels status --probe` peut vérifier des ID de groupe numériques explicites ; le joker `"*"` ne peut pas être sondé pour l'adhésion.
    - test de session rapide : `/activation always`.

  </Accordion>

  <Accordion title="Le bot ne voit pas du tout les messages de groupe">

    - quand `channels.telegram.groups` existe, le groupe doit être listé (ou inclure `"*"`)
    - vérifier l'adhésion du bot dans le groupe
    - examiner les logs : `openclaw logs --follow` pour les raisons d'ignorance

  </Accordion>

  <Accordion title="Les commandes fonctionnent partiellement ou pas du tout">

    - autoriser votre identité d'expéditeur (appairage et/ou `allowFrom` numérique)
    - l'autorisation de commande s'applique toujours même quand la politique de groupe est `open`
    - `setMyCommands failed` indique généralement des problèmes d'accessibilité DNS/HTTPS vers `api.telegram.org`

  </Accordion>

  <Accordion title="Instabilité de polling ou réseau">

    - Node 22+ + fetch/proxy personnalisé peut déclencher un comportement d'abandon immédiat si les types AbortSignal ne correspondent pas.
    - Certains hôtes résolvent `api.telegram.org` en IPv6 d'abord ; une sortie IPv6 cassée peut causer des échecs intermittents de l'API Telegram.
    - Valider les réponses DNS :

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

Plus d'aide : [Dépannage des canaux](/fr-FR/channels/troubleshooting).

## Pointeurs de référence de config Telegram

Référence principale :

- `channels.telegram.enabled` : activer/désactiver le démarrage du canal.
- `channels.telegram.botToken` : token du bot (BotFather).
- `channels.telegram.tokenFile` : lire le token depuis le chemin de fichier.
- `channels.telegram.dmPolicy` : `pairing | allowlist | open | disabled` (par défaut : pairing).
- `channels.telegram.allowFrom` : liste blanche DM (ID utilisateur numériques Telegram). `open` nécessite `"*"`. `openclaw doctor --fix` peut résoudre les anciennes entrées `@username` en ID.
- `channels.telegram.groupPolicy` : `open | allowlist | disabled` (par défaut : allowlist).
- `channels.telegram.groupAllowFrom` : liste blanche d'expéditeur de groupe (ID utilisateur numériques Telegram). `openclaw doctor --fix` peut résoudre les anciennes entrées `@username` en ID.
- `channels.telegram.groups` : valeurs par défaut par groupe + liste blanche (utiliser `"*"` pour les valeurs par défaut globales).
  - `channels.telegram.groups.<id>.groupPolicy` : remplacement par groupe pour groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention` : valeur par défaut de portail de mention.
  - `channels.telegram.groups.<id>.skills` : filtre de compétence (omettre = toutes les compétences, vide = aucune).
  - `channels.telegram.groups.<id>.allowFrom` : remplacement de liste blanche d'expéditeur par groupe.
  - `channels.telegram.groups.<id>.systemPrompt` : prompt système supplémentaire pour le groupe.
  - `channels.telegram.groups.<id>.enabled` : désactiver le groupe quand `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*` : remplacements par sujet (mêmes champs que groupe).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy` : remplacement par sujet pour groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention` : remplacement de portail de mention par sujet.
- `channels.telegram.capabilities.inlineButtons` : `off | dm | group | all | allowlist` (par défaut : allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons` : remplacement par compte.
- `channels.telegram.replyToMode` : `off | first | all` (par défaut : `off`).
- `channels.telegram.textChunkLimit` : taille de morceau sortant (caractères).
- `channels.telegram.chunkMode` : `length` (par défaut) ou `newline` pour diviser sur lignes vides (limites de paragraphe) avant découpage par longueur.
- `channels.telegram.linkPreview` : basculer les aperçus de lien pour les messages sortants (par défaut : true).
- `channels.telegram.streamMode` : `off | partial | block` (streaming de brouillon).
- `channels.telegram.mediaMaxMb` : plafond média entrant/sortant (Mo).
- `channels.telegram.retry` : politique de nouvelle tentative pour les appels Telegram API sortants (attempts, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily` : remplacer Node autoSelectFamily (true=activer, false=désactiver). Par défaut désactivé sur Node 22 pour éviter les timeouts Happy Eyeballs.
- `channels.telegram.proxy` : URL proxy pour les appels Bot API (SOCKS/HTTP).
- `channels.telegram.webhookUrl` : activer le mode webhook (nécessite `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret` : secret webhook (requis quand webhookUrl est défini).
- `channels.telegram.webhookPath` : chemin webhook local (par défaut `/telegram-webhook`).
- `channels.telegram.webhookHost` : hôte de liaison webhook local (par défaut `127.0.0.1`).
- `channels.telegram.actions.reactions` : portail de réactions d'outil Telegram.
- `channels.telegram.actions.sendMessage` : portail d'envois de message d'outil Telegram.
- `channels.telegram.actions.deleteMessage` : portail de suppressions de message d'outil Telegram.
- `channels.telegram.actions.sticker` : portail d'actions de sticker Telegram — envoi et recherche (par défaut : false).
- `channels.telegram.reactionNotifications` : `off | own | all` — contrôle quelles réactions déclenchent des événements système (par défaut : `own` quand non défini).
- `channels.telegram.reactionLevel` : `off | ack | minimal | extensive` — contrôle la capacité de réaction de l'agent (par défaut : `minimal` quand non défini).

- [Référence de configuration - Telegram](/fr-FR/gateway/configuration-reference#telegram)

Champs Telegram à fort signal :

- démarrage/auth : `enabled`, `botToken`, `tokenFile`, `accounts.*`
- contrôle d'accès : `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`
- commande/menu : `commands.native`, `customCommands`
- fil/réponses : `replyToMode`
- streaming : `streamMode`, `draftChunk`, `blockStreaming`
- formatage/livraison : `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- média/réseau : `mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- webhook : `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- actions/capacités : `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- réactions : `reactionNotifications`, `reactionLevel`
- écritures/historique : `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## Connexe

- [Appairage](/fr-FR/channels/pairing)
- [Routage de canal](/fr-FR/channels/channel-routing)
- [Dépannage](/fr-FR/channels/troubleshooting)
