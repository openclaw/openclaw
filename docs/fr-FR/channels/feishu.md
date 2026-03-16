---
summary: "Aperçu du bot Feishu, fonctionnalités et configuration"
read_when:
  - Vous voulez connecter un bot Feishu/Lark
  - Vous configurez le canal Feishu
title: Feishu
---

# Bot Feishu

Feishu (Lark) est une plateforme de chat d'équipe utilisée par les entreprises pour la messagerie et la collaboration. Ce plugin connecte OpenClaw à un bot Feishu/Lark en utilisant l'abonnement aux événements WebSocket de la plateforme afin que les messages puissent être reçus sans exposer une URL webhook publique.

---

## Plugin requis

Installez le plugin Feishu :

```bash
openclaw plugins install @openclaw/feishu
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/feishu
```

---

## Démarrage rapide

Il existe deux façons d'ajouter le canal Feishu :

### Méthode 1 : assistant d'onboarding (recommandé)

Si vous venez d'installer OpenClaw, exécutez l'assistant :

```bash
openclaw onboard
```

L'assistant vous guide à travers :

1. Création d'une app Feishu et collecte des identifiants
2. Configuration des identifiants d'app dans OpenClaw
3. Démarrage de la passerelle

✅ **Après configuration**, vérifiez le statut de la passerelle :

- `openclaw gateway status`
- `openclaw logs --follow`

### Méthode 2 : configuration CLI

Si vous avez déjà terminé l'installation initiale, ajoutez le canal via CLI :

```bash
openclaw channels add
```

Choisissez **Feishu**, puis entrez l'App ID et l'App Secret.

✅ **Après configuration**, gérez la passerelle :

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Étape 1 : Créer une app Feishu

### 1. Ouvrir Feishu Open Platform

Visitez [Feishu Open Platform](https://open.feishu.cn/app) et connectez-vous.

Les locataires Lark (global) doivent utiliser [https://open.larksuite.com/app](https://open.larksuite.com/app) et définir `domain: "lark"` dans la config Feishu.

### 2. Créer une app

1. Cliquez sur **Créer app d'entreprise**
2. Remplissez le nom + description de l'app
3. Choisissez une icône d'app

### 3. Copier les identifiants

Depuis **Identifiants & Infos de base**, copiez :

- **App ID** (format : `cli_xxx`)
- **App Secret**

❗ **Important :** gardez l'App Secret privé.

### 4. Configurer les permissions

Sur **Permissions**, cliquez sur **Import par lot** et collez :

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

### 5. Activer la capacité bot

Dans **Capacité d'app** > **Bot** :

1. Activez la capacité bot
2. Définissez le nom du bot

### 6. Configurer l'abonnement aux événements

⚠️ **Important :** avant de configurer l'abonnement aux événements, assurez-vous :

1. Vous avez déjà exécuté `openclaw channels add` pour Feishu
2. La passerelle fonctionne (`openclaw gateway status`)

Dans **Abonnement aux événements** :

1. Choisissez **Utiliser connexion longue pour recevoir événements** (WebSocket)
2. Ajoutez l'événement : `im.message.receive_v1`

⚠️ Si la passerelle ne fonctionne pas, la configuration de connexion longue peut échouer à sauvegarder.

### 7. Publier l'app

1. Créez une version dans **Gestion & Publication des versions**
2. Soumettez pour révision et publiez
3. Attendez l'approbation admin (les apps d'entreprise s'auto-approuvent généralement)

---

## Étape 2 : Configurer OpenClaw

### Configurer avec l'assistant (recommandé)

```bash
openclaw channels add
```

Choisissez **Feishu** et collez votre App ID + App Secret.

### Configurer via fichier de config

Éditez `~/.openclaw/openclaw.json` :

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
          botName: "Mon assistant IA",
        },
      },
    },
  },
}
```

### Configurer via variables d'environnement

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Domaine Lark (global)

Si votre locataire est sur Lark (international), définissez le domaine à `lark` (ou une chaîne de domaine complète). Vous pouvez le définir dans `channels.feishu.domain` ou par compte (`channels.feishu.accounts.<id>.domain`).

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

## Étape 3 : Démarrer + tester

### 1. Démarrer la passerelle

```bash
openclaw gateway
```

### 2. Envoyer un message test

Dans Feishu, trouvez votre bot et envoyez un message.

### 3. Approuver l'appairage

Par défaut, le bot répond avec un code d'appairage. Approuvez-le :

```bash
openclaw pairing approve feishu <CODE>
```

Après approbation, vous pouvez discuter normalement.

---

## Aperçu

- **Canal bot Feishu** : bot Feishu géré par la passerelle
- **Routage déterministe** : les réponses retournent toujours vers Feishu
- **Isolation de session** : les DM partagent une session principale ; les groupes sont isolés
- **Connexion WebSocket** : connexion longue via SDK Feishu, pas d'URL publique nécessaire

---

## Contrôle d'accès

### Messages directs

- **Par défaut** : `dmPolicy: "pairing"` (utilisateurs inconnus obtiennent un code d'appairage)
- **Approuver l'appairage** :

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Mode allowlist** : définissez `channels.feishu.allowFrom` avec les Open IDs autorisés

### Chats de groupe

**1. Politique de groupe** (`channels.feishu.groupPolicy`) :

- `"open"` = autoriser tout le monde dans les groupes (par défaut)
- `"allowlist"` = autoriser uniquement `groupAllowFrom`
- `"disabled"` = désactiver les messages de groupe

**2. Exigence de mention** (`channels.feishu.groups.<chat_id>.requireMention`) :

- `true` = nécessite @mention (par défaut)
- `false` = répond sans mentions

---

## Voir aussi

- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Plugins](/fr-FR/tools/plugin)
- [Appairage](/fr-FR/channels/pairing)
