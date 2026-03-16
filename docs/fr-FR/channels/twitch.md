---
summary: "Configuration bot chat Twitch et configuration"
read_when:
  - Configuration intégration chat Twitch pour OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Support chat Twitch via connexion IRC. OpenClaw se connecte en tant qu'utilisateur Twitch (compte bot) pour recevoir et envoyer des messages dans les canaux.

## Plugin requis

Twitch est fourni comme plugin et n'est pas inclus avec l'installation de base.

Installation via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/twitch
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/twitch
```

Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration rapide (débutant)

1. Créez un compte Twitch dédié pour le bot (ou utilisez un compte existant).
2. Générez les identifiants : [Générateur de Jeton Twitch](https://twitchtokengenerator.com/)
   - Sélectionnez **Bot Token**
   - Vérifiez que les scopes `chat:read` et `chat:write` sont sélectionnés
   - Copiez le **Client ID** et l'**Access Token**
3. Trouvez votre ID utilisateur Twitch : [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Configurez le jeton :
   - Env : `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (compte par défaut uniquement)
   - Ou config : `channels.twitch.accessToken`
   - Si les deux sont définis, la config a priorité (env fallback est uniquement compte par défaut).
5. Démarrez la passerelle.

**⚠️ Important :** Ajoutez le contrôle d'accès (`allowFrom` ou `allowedRoles`) pour empêcher les utilisateurs non autorisés de déclencher le bot. `requireMention` est `true` par défaut.

Configuration minimale :

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Compte Twitch du bot
      accessToken: "oauth:abc123...", // Jeton d'accès OAuth (ou utilisez variable env OPENCLAW_TWITCH_ACCESS_TOKEN)
      clientId: "xyz789...", // Client ID du Générateur de Jeton
      channel: "vevisk", // Quel canal de chat Twitch rejoindre (requis)
      allowFrom: ["123456789"], // (recommandé) Uniquement votre ID utilisateur Twitch - obtenez-le depuis https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Ce que c'est

- Un canal Twitch appartenant à la Passerelle.
- Routage déterministe : les réponses retournent toujours vers Twitch.
- Chaque compte mappe à une clé de session isolée `agent:<agentId>:twitch:<accountName>`.
- `username` est le compte du bot (qui s'authentifie), `channel` est quelle salle de chat rejoindre.

## Configuration (détaillée)

### Générer les identifiants

Utilisez [Générateur de Jeton Twitch](https://twitchtokengenerator.com/) :

- Sélectionnez **Bot Token**
- Vérifiez que les scopes `chat:read` et `chat:write` sont sélectionnés
- Copiez le **Client ID** et l'**Access Token**

Aucune inscription manuelle d'app nécessaire. Les jetons expirent après plusieurs heures.

### Configurer le bot

**Variable env (compte par défaut uniquement) :**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Ou config :**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Si env et config sont définis, la config a priorité.

### Contrôle d'accès (recommandé)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommandé) Uniquement votre ID utilisateur Twitch
    },
  },
}
```

Préférez `allowFrom` pour une allowlist stricte. Utilisez `allowedRoles` si vous voulez un accès basé sur les rôles.

**Rôles disponibles :** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Pourquoi des IDs utilisateur ?** Les noms d'utilisateur peuvent changer, permettant l'usurpation. Les IDs utilisateur sont permanents.

Trouvez votre ID utilisateur Twitch : [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/) (Convertir votre nom d'utilisateur Twitch en ID)

## Rafraîchissement de jeton (optionnel)

Les jetons de [Générateur de Jeton Twitch](https://twitchtokengenerator.com/) ne peuvent pas être automatiquement rafraîchis - régénérez quand expiré.

Pour le rafraîchissement automatique de jeton, créez votre propre application Twitch sur [Console Développeur Twitch](https://dev.twitch.tv/console) et ajoutez à la config :

```json5
{
  channels: {
    twitch: {
      clientSecret: "votre_client_secret",
      refreshToken: "votre_refresh_token",
    },
  },
}
```

Le bot rafraîchit automatiquement les jetons avant expiration et enregistre les événements de rafraîchissement.

## Support multi-comptes

Utilisez `channels.twitch.accounts` avec jetons par compte. Voir [`gateway/configuration`](/fr-FR/gateway/configuration) pour le modèle partagé.

Exemple (un compte bot dans deux canaux) :

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Note :** Chaque compte nécessite son propre jeton (un jeton par canal).

## Contrôle d'accès

### Restrictions basées sur les rôles

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Allowlist par ID utilisateur (plus sécurisé)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Accès basé sur les rôles (alternative)

`allowFrom` est une allowlist stricte. Quand défini, seuls ces IDs utilisateur sont autorisés. Si vous voulez un accès basé sur les rôles, laissez `allowFrom` non défini et configurez `allowedRoles` à la place :

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Désactiver l'exigence @mention

Par défaut, `requireMention` est `true`. Pour désactiver et répondre à tous les messages :

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Dépannage

D'abord, exécutez les commandes de diagnostic :

```bash
openclaw doctor
openclaw channels status --probe
```

### Le bot ne répond pas aux messages

**Vérifiez le contrôle d'accès :** Assurez-vous que votre ID utilisateur est dans `allowFrom`, ou supprimez temporairement `allowFrom` et définissez `allowedRoles: ["all"]` pour tester.

**Vérifiez que le bot est dans le canal :** Le bot doit rejoindre le canal spécifié dans `channel`.

### Problèmes de jeton

**"Échec de connexion" ou erreurs d'authentification :**

- Vérifiez que `accessToken` est la valeur du jeton d'accès OAuth (commence typiquement par le préfixe `oauth:`)
- Vérifiez que le jeton a les scopes `chat:read` et `chat:write`
- Si utilisation du rafraîchissement de jeton, vérifiez que `clientSecret` et `refreshToken` sont définis

### Le rafraîchissement de jeton ne fonctionne pas

**Vérifiez les journaux pour les événements de rafraîchissement :**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Si vous voyez "token refresh disabled (no refresh token)" :

- Assurez-vous que `clientSecret` est fourni
- Assurez-vous que `refreshToken` est fourni

## Configuration

**Configuration de compte :**

- `username` - Nom d'utilisateur bot
- `accessToken` - Jeton d'accès OAuth avec `chat:read` et `chat:write`
- `clientId` - Client ID Twitch (depuis Générateur de Jeton ou votre app)
- `channel` - Canal à rejoindre (requis)
- `enabled` - Activer ce compte (par défaut : `true`)
- `clientSecret` - Optionnel : Pour rafraîchissement automatique jeton
- `refreshToken` - Optionnel : Pour rafraîchissement automatique jeton
- `expiresIn` - Expiration jeton en secondes
- `obtainmentTimestamp` - Horodatage obtention jeton
- `allowFrom` - Allowlist ID utilisateur
- `allowedRoles` - Contrôle d'accès basé rôles (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Nécessite @mention (par défaut : `true`)

**Options du fournisseur :**

- `channels.twitch.enabled` - Activer/désactiver démarrage canal
- `channels.twitch.username` - Nom d'utilisateur bot (config compte unique simplifiée)
- `channels.twitch.accessToken` - Jeton d'accès OAuth (config compte unique simplifiée)
- `channels.twitch.clientId` - Client ID Twitch (config compte unique simplifiée)
- `channels.twitch.channel` - Canal à rejoindre (config compte unique simplifiée)
- `channels.twitch.accounts.<accountName>` - Config multi-comptes (tous les champs compte ci-dessus)

## Actions outils

L'agent peut appeler `twitch` avec action :

- `send` - Envoyer un message à un canal

Exemple :

```json5
{
  action: "twitch",
  params: {
    message: "Bonjour Twitch !",
    to: "#mychannel",
  },
}
```

## Sécurité et opérations

- **Traitez les jetons comme des mots de passe** - Ne committez jamais les jetons dans git
- **Utilisez le rafraîchissement automatique de jeton** pour les bots longue durée
- **Utilisez les allowlists d'ID utilisateur** au lieu des noms d'utilisateur pour le contrôle d'accès
- **Surveillez les journaux** pour les événements de rafraîchissement de jeton et le statut de connexion
- **Limitez les scopes de jetons** - Demandez uniquement `chat:read` et `chat:write`
- **Si bloqué** : Redémarrez la passerelle après avoir confirmé qu'aucun autre processus ne possède la session

## Limites

- **500 caractères** par message (découpage automatique aux limites de mots)
- Le Markdown est supprimé avant le découpage
- Pas de limitation de taux (utilise les limites de taux intégrées Twitch)

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
