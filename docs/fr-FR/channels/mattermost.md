---
summary: "Configuration bot Mattermost et config OpenClaw"
read_when:
  - Configuration de Mattermost
  - Débogage routage Mattermost
title: "Mattermost"
---

# Mattermost (plugin)

Statut : supporté via plugin (jeton bot + événements WebSocket). Canaux, groupes et DM sont supportés. Mattermost est une plateforme de messagerie d'équipe auto-hébergeable ; voir le site officiel sur [mattermost.com](https://mattermost.com) pour détails produit et téléchargements.

## Plugin requis

Mattermost est fourni comme plugin et n'est pas inclus avec l'installation de base.

Installation via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/mattermost
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/mattermost
```

Si vous choisissez Mattermost pendant configure/onboarding et qu'un checkout git est détecté, OpenClaw offrira automatiquement le chemin d'installation local.

Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration rapide

1. Installez le plugin Mattermost.
2. Créez un compte bot Mattermost et copiez le **jeton bot**.
3. Copiez l'**URL de base** Mattermost (par ex., `https://chat.example.com`).
4. Configurez OpenClaw et démarrez la passerelle.

Configuration minimale :

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Variables d'environnement (compte par défaut)

Définissez-les sur l'hôte passerelle si vous préférez les variables d'environnement :

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Les variables d'environnement s'appliquent uniquement au compte **par défaut** (`default`). Les autres comptes doivent utiliser les valeurs de config.

## Modes de chat

Mattermost répond automatiquement aux DM. Le comportement canal est contrôlé par `chatmode` :

- `oncall` (par défaut) : répondre uniquement quand @mentionné dans les canaux.
- `onmessage` : répondre à chaque message de canal.
- `onchar` : répondre quand un message commence par un préfixe de déclenchement.

Exemple de config :

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notes :

- `onchar` répond toujours aux @mentions explicites.
- `channels.mattermost.requireMention` est honoré pour les configs legacy mais `chatmode` est préféré.

## Contrôle d'accès (DM)

- Par défaut : `channels.mattermost.dmPolicy = "pairing"` (les expéditeurs inconnus obtiennent un code d'appairage).
- Approuver via :
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- DM publics : `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Canaux (groupes)

- Par défaut : `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- Allowlist expéditeurs avec `channels.mattermost.groupAllowFrom` (IDs utilisateur ou `@username`).
- Canaux ouverts : `channels.mattermost.groupPolicy="open"` (mention-gated).

## Cibles pour livraison sortante

Utilisez ces formats de cible avec `openclaw message send` ou cron/webhooks :

- `channel:<id>` pour un canal
- `user:<id>` pour un DM
- `@username` pour un DM (résolu via l'API Mattermost)

Les IDs nus sont traités comme canaux.

## Multi-comptes

Mattermost supporte plusieurs comptes sous `channels.mattermost.accounts` :

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Principal", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alertes", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Dépannage

- Aucune réponse dans les canaux : assurez-vous que le bot est dans le canal et mentionnez-le (oncall), utilisez un préfixe de déclenchement (onchar), ou définissez `chatmode: "onmessage"`.
- Erreurs d'authentification : vérifiez le jeton bot, l'URL de base et si le compte est activé.
- Problèmes multi-comptes : les variables d'environnement s'appliquent uniquement au compte `default`.

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
