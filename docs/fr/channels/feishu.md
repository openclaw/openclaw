---
summary: "Présentation du bot Feishu, fonctionnalités et configuration"
read_when:
  - Vous souhaitez connecter un bot Feishu/Lark
  - Vous configurez le canal Feishu
title: Feishu
---

# Bot Feishu

Feishu (Lark) est une plateforme de discussion d’équipe utilisée par les entreprises pour la messagerie et la collaboration. Ce plugin connecte OpenClaw à un bot Feishu/Lark en utilisant l’abonnement aux événements WebSocket de la plateforme, ce qui permet de recevoir des messages sans exposer d’URL de webhook publique.

---

## Plugin requis

Installez le plugin Feishu :

```bash
openclaw plugins install @openclaw/feishu
```

Clonage local (lors d’une exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/feishu
```

---

## Démarrage rapide

Il existe deux façons d’ajouter le canal Feishu :

### Méthode 1 : assistant de prise en main (recommandé)

Si vous venez d’installer OpenClaw, lancez l’assistant :

```bash
openclaw onboard
```

L’assistant vous guide pour :

1. Créer une application Feishu et collecter les identifiants
2. Configurer les identifiants de l’application dans OpenClaw
3. Démarrer la passerelle

✅ **Après la configuration**, vérifiez l’état de la passerelle :

- `openclaw gateway status`
- `openclaw logs --follow`

### Méthode 2 : configuration via la CLI

Si vous avez déjà terminé l’installation initiale, ajoutez le canal via la CLI :

```bash
openclaw channels add
```

Choisissez **Feishu**, puis saisissez l’App ID et l’App Secret.

✅ **Après la configuration**, gérez la passerelle :

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Étape 1 : Créer une application Feishu

### 1. Ouvrir la plateforme Feishu Open Platform

Visitez [Feishu Open Platform](https://open.feishu.cn/app) et connectez-vous.

Les tenants Lark (globaux) doivent utiliser https://open.larksuite.com/app et définir `domain: "lark"` dans la configuration Feishu.

### 2. Créer une application

1. Cliquez sur **Create enterprise app**
2. Renseignez le nom et la description de l’application
3. Choisissez une icône d’application

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Copier les identifiants

Depuis **Credentials & Basic Info**, copiez :

- **App ID** (format : `cli_xxx`)
- **App Secret**

❗ **Important :** conservez l’App Secret de manière confidentielle.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Configurer les permissions

Dans **Permissions**, cliquez sur **Batch import** et collez :

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Activer la capacité bot

Dans **App Capability** > **Bot** :

1. Activez la capacité bot
2. Définissez le nom du bot

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Configurer l’abonnement aux événements

⚠️ **Important :** avant de configurer l’abonnement aux événements, assurez-vous que :

1. Vous avez déjà exécuté `openclaw channels add` pour Feishu
2. La passerelle est en cours d’exécution (`openclaw gateway status`)

Dans **Event Subscription** :

1. Choisissez **Use long connection to receive events** (WebSocket)
2. Ajoutez l’événement : `im.message.receive_v1`

⚠️ Si la passerelle n’est pas en cours d’exécution, la configuration de la connexion longue peut échouer à l’enregistrement.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publier l’application

1. Créez une version dans **Version Management & Release**
2. Soumettez-la pour revue et publiez
3. Attendez l’approbation de l’administrateur (les applications d’entreprise sont généralement approuvées automatiquement)

---

## Étape 2 : Configurer OpenClaw

### Configuration avec l’assistant (recommandé)

```bash
openclaw channels add
```

Choisissez **Feishu** et collez votre App ID et votre App Secret.

### Configuration via le fichier de configuration

Modifiez `~/.openclaw/openclaw.json` :

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Configuration via les variables d’environnement

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Domaine Lark (global)

Si votre tenant est sur Lark (international), définissez le domaine sur `lark` (ou une chaîne de domaine complète). Vous pouvez le définir dans `channels.feishu.domain` ou par compte (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Étape 3 : Démarrer et tester

### 1. Démarrer la passerelle

```bash
openclaw gateway
```

### 2. Envoyer un message de test

Dans Feishu, trouvez votre bot et envoyez un message.

### 3. Approuver l’appairage

Par défaut, le bot répond avec un code d’appairage. Approuvez-le :

```bash
openclaw pairing approve feishu <CODE>
```

Après l’approbation, vous pouvez discuter normalement.

---

## Présentation

- **Canal bot Feishu** : bot Feishu géré par la passerelle
- **Routage déterministe** : les réponses retournent toujours vers Feishu
- **Isolation des sessions** : les Messages prives partagent une session principale ; les groupes sont isolés
- **Connexion WebSocket** : connexion longue via le SDK Feishu, aucune URL publique requise

---

## Contrôle d’accès

### Messages directs

- **Par défaut** : `dmPolicy: "pairing"` (les utilisateurs inconnus reçoivent un code d’appairage)

- **Approuver l’appairage** :

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Mode liste d’autorisation** : définissez `channels.feishu.allowFrom` avec les Open ID autorisés

### Discussions de groupe

**1. Politique de groupe** (`channels.feishu.groupPolicy`) :

- `"open"` = autoriser tout le monde dans les groupes (par défaut)
- `"allowlist"` = autoriser uniquement `groupAllowFrom`
- `"disabled"` = désactiver les messages de groupe

**2. Exigence de mention** (`channels.feishu.groups.<chat_id>.requireMention`) :

- `true` = exiger une mention @ (par défaut)
- `false` = répondre sans mention

---

## Exemples de configuration des groupes

### Autoriser tous les groupes, mention @ requise (par défaut)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Autoriser tous les groupes, sans mention @ requise

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Autoriser uniquement des utilisateurs spécifiques dans les groupes

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Obtenir les identifiants de groupe/utilisateur

### Identifiants de groupe (chat_id)

Les identifiants de groupe ressemblent à `oc_xxx`.

**Méthode 1 (recommandée)**

1. Démarrez la passerelle et mentionnez le bot avec @ dans le groupe
2. Exécutez `openclaw logs --follow` et recherchez `chat_id`

**Méthode 2**

Utilisez le débogueur de l’API Feishu pour lister les discussions de groupe.

### Identifiants utilisateur (open_id)

Les identifiants utilisateur ressemblent à `ou_xxx`.

**Méthode 1 (recommandée)**

1. Démarrez la passerelle et envoyez un Message prive au bot
2. Exécutez `openclaw logs --follow` et recherchez `open_id`

**Méthode 2**

Consultez les demandes d’appairage pour les Open ID des utilisateurs :

```bash
openclaw pairing list feishu
```

---

## Commandes courantes

| Commande  | Description                |
| --------- | -------------------------- |
| `/status` | Afficher l’état du bot     |
| `/reset`  | Réinitialiser la session   |
| `/model`  | Afficher/changer le modèle |

> Remarque : Feishu ne prend pas encore en charge les menus de commandes natifs, les commandes doivent donc être envoyées sous forme de texte.

## Commandes de gestion de la passerelle

| Commande                   | Description                                 |
| -------------------------- | ------------------------------------------- |
| `openclaw gateway status`  | Afficher l’état de la passerelle            |
| `openclaw gateway install` | Installer/démarrer le service de passerelle |
| `openclaw gateway stop`    | Arrêter le service de passerelle            |
| `openclaw gateway restart` | Redémarrer le service de passerelle         |
| `openclaw logs --follow`   | Journaux de la passerelle de la queue       |

---

## Problemes courants

### Le bot ne répond pas dans les discussions de groupe

1. Assurez-vous que le bot est ajouté au groupe
2. Assurez-vous de mentionner le bot avec @ (comportement par défaut)
3. Vérifiez que `groupPolicy` n’est pas défini sur `"disabled"`
4. Vérifiez les journaux : `openclaw logs --follow`

### Le bot ne reçoit pas de messages

1. Assurez-vous que l’application est publiée et approuvée
2. Assurez-vous que l’abonnement aux événements inclut `im.message.receive_v1`
3. Assurez-vous que la **connexion longue** est activée
4. Assurez-vous que les permissions de l’application sont complètes
5. Assurez-vous que la passerelle est en cours d’exécution : `openclaw gateway status`
6. Vérifiez les journaux : `openclaw logs --follow`

### Fuite de l’App Secret

1. Réinitialisez l’App Secret dans Feishu Open Platform
2. Mettez à jour l’App Secret dans votre configuration
3. Redémarrez la passerelle

### Échecs d’envoi de messages

1. Assurez-vous que l’application dispose de la permission `im:message:send_as_bot`
2. Assurez-vous que l’application est publiée
3. Consultez les journaux pour des erreurs détaillées

---

## Configuration avancée

### Comptes multiples

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Limites de messages

- `textChunkLimit` : taille des segments de texte sortants (par défaut : 2000 caractères)
- `mediaMaxMb` : limite de téléversement/téléchargement des médias (par défaut : 30 Mo)

### Streaming

Feishu prend en charge les réponses en streaming via des cartes interactives. Lorsqu’il est activé, le bot met à jour une carte au fur et à mesure de la génération du texte.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Définissez `streaming: false` pour attendre la réponse complète avant l’envoi.

### Routage multi-agents

Utilisez `bindings` pour router les Messages prives ou groupes Feishu vers différents agents.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Champs de routage :

- `match.channel` : `"feishu"`
- `match.peer.kind` : `"dm"` ou `"group"`
- `match.peer.id` : Open ID utilisateur (`ou_xxx`) ou identifiant de groupe (`oc_xxx`)

Voir [Obtenir les identifiants de groupe/utilisateur](#get-groupuser-ids) pour des conseils de recherche.

---

## Référence de configuration

Configuration complète : [Configuration de la passerelle](/gateway/configuration)

Options clés :

| Paramètre                                         | Description                                                                       | Valeur par défaut |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `channels.feishu.enabled`                         | Activer/désactiver le canal                                                       | `true`            |
| `channels.feishu.domain`                          | Domaine API (`feishu` ou `lark`)                               | `feishu`          |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                                            | -                 |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                                        | -                 |
| `channels.feishu.accounts.<id>.domain`            | Remplacement du domaine API par compte                                            | `feishu`          |
| `channels.feishu.dmPolicy`                        | Politique de DM                                                                   | `pairing`         |
| `channels.feishu.allowFrom`                       | Liste d’autorisation DM (liste d’open_id) | -                 |
| `channels.feishu.groupPolicy`                     | Politique de groupe                                                               | `open`            |
| `channels.feishu.groupAllowFrom`                  | Liste d’autorisation de groupe                                                    | -                 |
| `channels.feishu.groups.<chat_id>.requireMention` | Exiger @mention                                                      | `true`            |
| `channels.feishu.groups.<chat_id>.enabled`        | Activer les groupes                                                               | `true`            |
| `channels.feishu.textChunkLimit`                  | Taille des segments de message                                                    | `2000`            |
| `channels.feishu.mediaMaxMb`                      | Limite de taille des médias                                                       | `30`              |
| `channels.feishu.streaming`                       | Activer la sortie de cartes en streaming                                          | `true`            |
| `channels.feishu.blockStreaming`                  | Activer le streaming par blocs                                                    | `true`            |

---

## Référence dmPolicy

| Valeur        | Comportement                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `"pairing"`   | **Par défaut.** Les utilisateurs inconnus reçoivent un code d’appairage ; approbation requise |
| `"allowlist"` | Seuls les utilisateurs dans `allowFrom` peuvent discuter                                                      |
| `"open"`      | Autoriser tous les utilisateurs (nécessite `"*"` dans allowFrom)                           |
| `"disabled"`  | Désactiver les DMs                                                                                            |

---

## Types de messages pris en charge

### Réception

- ✅ Texte
- ✅ Texte enrichi (post)
- ✅ Images
- ✅ Fichiers
- ✅ Audio
- ✅ Vidéo
- ✅ Autocollants

### Envoi

- ✅ Texte
- ✅ Images
- ✅ Fichiers
- ✅ Audio
- ⚠️ Texte enrichi (prise en charge partielle)
