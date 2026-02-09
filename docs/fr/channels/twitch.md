---
summary: "Configuration et configuration initiale du bot de chat Twitch"
read_when:
  - Configuration de l’integration du chat Twitch pour OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Prise en charge du chat Twitch via une connexion IRC. OpenClaw se connecte en tant qu’utilisateur Twitch (compte bot) pour recevoir et envoyer des messages dans des canaux.

## Plugin requis

Twitch est distribue sous forme de plugin et n’est pas inclus dans l’installation de base.

Installer via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/twitch
```

Installation locale (lors d’une execution depuis un depot git) :

```bash
openclaw plugins install ./extensions/twitch
```

Details : [Plugins](/plugin)

## Demarrage rapide (debutant)

1. Creez un compte Twitch dedie pour le bot (ou utilisez un compte existant).
2. Generez les informations d’identification : [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Selectionnez **Bot Token**
   - Verifiez que les portees `chat:read` et `chat:write` sont selectionnees
   - Copiez le **Client ID** et l’**Access Token**
3. Trouvez votre identifiant utilisateur Twitch : https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
4. Configurez le jeton :
   - Variable d’environnement : `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (compte par defaut uniquement)
   - Ou configuration : `channels.twitch.accessToken`
   - Si les deux sont definis, la configuration est prioritaire (la variable d’environnement ne sert que de secours pour le compte par defaut).
5. Demarrez la Gateway (passerelle).

**⚠️ Important :** Ajoutez un controle d’acces (`allowFrom` ou `allowedRoles`) pour empecher des utilisateurs non autorises de declencher le bot. `requireMention` est par defaut a `true`.

Configuration minimale :

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Ce que c’est

- Un canal Twitch possede par la Gateway (passerelle).
- Routage deterministe : les reponses retournent toujours vers Twitch.
- Chaque compte correspond a une cle de session isolee `agent:<agentId>:twitch:<accountName>`.
- `username` est le compte du bot (qui s’authentifie), `channel` est le salon de discussion a rejoindre.

## Configuration (detaillee)

### Generer les informations d’identification

Utilisez [Twitch Token Generator](https://twitchtokengenerator.com/) :

- Selectionnez **Bot Token**
- Verifiez que les portees `chat:read` et `chat:write` sont selectionnees
- Copiez le **Client ID** et l’**Access Token**

Aucune inscription manuelle d’application n’est necessaire. Les jetons expirent apres plusieurs heures.

### Configurer le bot

**Env var (compte par défaut uniquement) :**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Ou configuration :**

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

Si la variable d’environnement et la configuration sont toutes deux definies, la configuration est prioritaire.

### Controle d’acces (recommande)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Preferez `allowFrom` pour une liste d’autorisation stricte. Utilisez `allowedRoles` a la place si vous souhaitez un acces base sur les roles.

**Roles disponibles :** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Pourquoi les identifiants utilisateur ?** Les noms d’utilisateur peuvent changer, permettant l’usurpation d’identite. Les identifiants utilisateur sont permanents.

Trouvez votre identifiant utilisateur Twitch : https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/ (Convertissez votre nom d’utilisateur Twitch en identifiant)

## Renouvellement du jeton (optionnel)

Les jetons issus de [Twitch Token Generator](https://twitchtokengenerator.com/) ne peuvent pas etre renouvelles automatiquement ; regenerez-les lorsqu’ils expirent.

Pour un renouvellement automatique des jetons, creez votre propre application Twitch dans la [Twitch Developer Console](https://dev.twitch.tv/console) et ajoutez-la a la configuration :

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Le bot renouvelle automatiquement les jetons avant leur expiration et consigne les evenements de renouvellement.

## Prise en charge multi-comptes

Utilisez `channels.twitch.accounts` avec des jetons par compte. Voir [`gateway/configuration`](/gateway/configuration) pour le schema partage.

Exemple (un compte bot dans deux canaux) :

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

**Remarque :** Chaque compte necessite son propre jeton (un jeton par canal).

## Controle d’acces

### Restrictions basees sur les roles

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

### Liste d’autorisation par identifiant utilisateur (la plus securisee)

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

### Acces base sur les roles (alternative)

`allowFrom` est une liste d’autorisation stricte. Lorsqu’elle est definie, seuls ces identifiants utilisateur sont autorises.
Si vous souhaitez un acces base sur les roles, laissez `allowFrom` non defini et configurez `allowedRoles` a la place :

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

### Desactiver l’exigence de @mention

Par defaut, `requireMention` est `true`. Pour desactiver et repondre a tous les messages :

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

## Problemes courants

Commencez par executer les commandes de diagnostic :

```bash
openclaw doctor
openclaw channels status --probe
```

### Le bot ne repond pas aux messages

**Verifier le controle d’acces :** Assurez-vous que votre identifiant utilisateur figure dans `allowFrom`, ou supprimez temporairement
`allowFrom` et definissez `allowedRoles: ["all"]` pour tester.

**Verifier que le bot est dans le canal :** Le bot doit rejoindre le canal specifie dans `channel`.

### Problèmes de jeton

**« Failed to connect » ou erreurs d’authentification :**

- Verifiez que `accessToken` correspond a la valeur du jeton d’acces OAuth (commence generalement par le prefixe `oauth:`)
- Verifiez que le jeton possede les portees `chat:read` et `chat:write`
- Si vous utilisez le renouvellement de jeton, verifiez que `clientSecret` et `refreshToken` sont definis

### L'actualisation du jeton ne fonctionne pas

**Verifier les journaux pour les evenements de renouvellement :**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Si vous voyez « token refresh disabled (no refresh token) » :

- Assurez-vous que `clientSecret` est fourni
- Assurez-vous que `refreshToken` est fourni

## Configuration

**Configuration de compte :**

- `username` - Nom d’utilisateur du bot
- `accessToken` - Jeton d’acces OAuth avec `chat:read` et `chat:write`
- `clientId` - Client ID Twitch (depuis le Token Generator ou votre application)
- `channel` - Canal a rejoindre (requis)
- `enabled` - Activer ce compte (par defaut : `true`)
- `clientSecret` - Optionnel : pour le renouvellement automatique des jetons
- `refreshToken` - Optionnel : pour le renouvellement automatique des jetons
- `expiresIn` - Expiration du jeton en secondes
- `obtainmentTimestamp` - Horodatage d’obtention du jeton
- `allowFrom` - Liste d’autorisation des identifiants utilisateur
- `allowedRoles` - Controle d’acces base sur les roles (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Exiger une @mention (par defaut : `true`)

**Options du fournisseur :**

- `channels.twitch.enabled` - Activer/desactiver le demarrage du canal
- `channels.twitch.username` - Nom d’utilisateur du bot (configuration simplifiee a compte unique)
- `channels.twitch.accessToken` - Jeton d’acces OAuth (configuration simplifiee a compte unique)
- `channels.twitch.clientId` - Client ID Twitch (configuration simplifiee a compte unique)
- `channels.twitch.channel` - Canal a rejoindre (configuration simplifiee a compte unique)
- `channels.twitch.accounts.<accountName>` - Configuration multi-comptes (tous les champs de compte ci-dessus)

Exemple complet :

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Actions d’outil

L’agent peut appeler `twitch` avec l’action :

- `send` - Envoyer un message a un canal

Exemple :

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Securite et exploitation

- **Traitez les jetons comme des mots de passe** - Ne commitez jamais les jetons dans git
- **Utilisez le renouvellement automatique des jetons** pour les bots de longue duree
- **Utilisez des listes d’autorisation par identifiant utilisateur** plutot que des noms d’utilisateur pour le controle d’acces
- **Surveillez les journaux** pour les evenements de renouvellement de jeton et l’etat de connexion
- **Limitez les portees des jetons** - Ne demandez que `chat:read` et `chat:write`
- **En cas de blocage** : Redemarrez la Gateway (passerelle) apres avoir confirme qu’aucun autre processus ne possede la session

## Limites

- **500 caracteres** par message (segmentation automatique aux limites de mots)
- Le Markdown est supprime avant la segmentation
- Pas de limitation de debit (utilise les limites integrees de Twitch)
