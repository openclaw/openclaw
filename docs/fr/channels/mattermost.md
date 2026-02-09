---
summary: "Configuration du bot Mattermost et configuration OpenClaw"
read_when:
  - Configuration de Mattermost
  - Debogage du routage Mattermost
title: "Mattermost"
---

# Mattermost (plugin)

Statut : pris en charge via un plugin (jeton de bot + evenements WebSocket). Les canaux, groupes et Messages prives sont pris en charge.
Mattermost est une plateforme de messagerie d’equipe auto-hebergeable ; consultez le site officiel a l’adresse
[mattermost.com](https://mattermost.com) pour les details du produit et les telechargements.

## Plugin requis

Mattermost est distribue sous forme de plugin et n’est pas inclus dans l’installation de base.

Installation via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/mattermost
```

Extraction locale (lorsque vous executez depuis un depot git) :

```bash
openclaw plugins install ./extensions/mattermost
```

Si vous choisissez Mattermost pendant la configuration/la prise en main et qu’une extraction git est detectee,
OpenClaw proposera automatiquement le chemin d’installation locale.

Details : [Plugins](/plugin)

## Demarrage rapide

1. Installez le plugin Mattermost.
2. Creez un compte bot Mattermost et copiez le **jeton du bot**.
3. Copiez l’**URL de base** Mattermost (par ex., `https://chat.example.com`).
4. Configurez OpenClaw et demarrez la passerelle.

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

## Variables d'environnement (compte par defaut)

Définissez ces paramètres sur l'hôte de la passerelle si vous préférez les variables env :

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Les variables d'environnement ne s’appliquent qu’au compte **par defaut** (`default`). Les autres comptes doivent utiliser des valeurs de configuration.

## Modes de chat

Mattermost repond automatiquement aux Messages prives. Le comportement dans les canaux est controle par `chatmode` :

- `oncall` (par defaut) : repond uniquement lorsqu’il est @mentionne dans les canaux.
- `onmessage` : repond a chaque message du canal.
- `onchar` : repond lorsqu’un message commence par un prefixe de declenchement.

Exemple de configuration :

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

- `onchar` repond toujours aux @mentions explicites.
- `channels.mattermost.requireMention` est respecte pour les configurations heritees, mais `chatmode` est prefere.

## Contrôle d'accès (DMs)

- Par defaut : `channels.mattermost.dmPolicy = "pairing"` (les expéditeurs inconnus recoivent un code d’appairage).
- Approbation via :
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Messages prives publics : `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Canaux (groupes)

- Par defaut : `channels.mattermost.groupPolicy = "allowlist"` (restreint par mention).
- Autorisez des expéditeurs via une liste d’autorisation avec `channels.mattermost.groupAllowFrom` (identifiants utilisateur ou `@username`).
- Canaux ouverts : `channels.mattermost.groupPolicy="open"` (restreint par mention).

## Cibles pour la livraison sortante

Utilisez ces formats de cible avec `openclaw message send` ou des cron/webhooks :

- `channel:<id>` pour un canal
- `user:<id>` pour un Message prive
- `@username` pour un Message prive (resolu via l’API Mattermost)

Les identifiants nus sont traites comme des canaux.

## Multi-comptes

Mattermost prend en charge plusieurs comptes sous `channels.mattermost.accounts` :

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Problemes courants

- Aucune reponse dans les canaux : assurez-vous que le bot est dans le canal et mentionnez-le (oncall), utilisez un prefixe de declenchement (onchar) ou definissez `chatmode: "onmessage"`.
- Erreurs d’authentification : verifiez le jeton du bot, l’URL de base et que le compte est active.
- Problemes multi-comptes : les variables d'environnement s’appliquent uniquement au compte `default`.
