---
summary: "Statut support bot Microsoft Teams, capabilities et configuration"
read_when:
  - Travail sur fonctionnalités canal MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Abandon all hope, ye who enter here."

Mis à jour : 2026-01-21

Statut : texte + pièces jointes DM supportés ; envoi fichiers canal/groupe requiert `sharePointSiteId` + permissions Graph (voir [Envoi fichiers dans chats groupe](#envoi-fichiers-dans-chats-groupe)). Polls envoyés via Adaptive Cards.

## Plugin requis

Microsoft Teams shipped comme plugin et n'est pas bundled avec install core.

**Breaking change (2026.1.15) :** MS Teams sorti de core. Si vous l'utilisez, vous devez installer plugin.

Explicable : garde installs core plus légères et laisse dépendances MS Teams updater indépendamment.

Installez via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/msteams
```

Checkout local (quand tournant depuis repo git) :

```bash
openclaw plugins install ./extensions/msteams
```

Si vous choisissez Teams pendant configure/onboarding et checkout git détecté, OpenClaw offrira chemin install local automatiquement.

Détails : [Plugins](/fr-FR/tools/plugin)

## Setup rapide (débutant)

1. Installez plugin Microsoft Teams.
2. Créez **Azure Bot** (App ID + client secret + tenant ID).
3. Configurez OpenClaw avec ces credentials.
4. Exposez `/api/messages` (port 3978 par défaut) via URL publique ou tunnel.
5. Installez package app Teams et démarrez passerelle.

Config minimale :

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Note : chats groupe bloqués par défaut (`channels.msteams.groupPolicy: "allowlist"`). Pour autoriser réponses groupe, définissez `channels.msteams.groupAllowFrom` (ou utilisez `groupPolicy: "open"` pour autoriser n'importe quel membre, mention-gated).

## Objectifs

- Parler à OpenClaw via DMs Teams, chats groupe ou canaux.
- Garder routing déterministe : réponses retournent toujours vers canal d'arrivée.
- Défaut vers comportement canal sûr (mentions requises sauf config contraire).

## Écritures config

Par défaut, Microsoft Teams autorisé écrire updates config déclenchées par `/config set|unset` (requiert `commands.config: true`).

Désactivez avec :

```json5
{
  channels: {
    msteams: {
      allowConfigWrite: false,
    },
  },
}
```

## Envoi fichiers dans chats groupe

Envoi fichiers groupe Teams requiert :

1. **SharePoint Site ID** : `channels.msteams.sharePointSiteId`
2. **Permissions Graph** : `Sites.ReadWrite.All` ou `Files.ReadWrite.All`
3. **Drive ID** (optionnel) : auto-résolu depuis Site ID si non fourni

```json5
{
  channels: {
    msteams: {
      sharePointSiteId: "<SITE_ID>",
      // driveId: "<DRIVE_ID>"  // Optionnel
    },
  },
}
```

Sans ceci, envois fichiers groupe échoueront avec erreur permission.

## Adaptive Cards

Polls envoyés via Adaptive Cards :

```json5
{
  channels: {
    msteams: {
      adaptiveCards: true, // Défaut : true
    },
  },
}
```

## Routing groupe

Contrôlez qui peut déclencher agent dans groupes :

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist", // "open" | "allowlist" | "closed"
      groupAllowFrom: ["user@example.com"],
    },
  },
}
```

- `open` : n'importe quel membre peut @ mentionner bot
- `allowlist` : seulement members dans `groupAllowFrom`
- `closed` : aucune réponse groupe

Voir aussi :

- [Plugins](/fr-FR/tools/plugin)
- [Canaux](/fr-FR/channels/index)
- [Configuration](/fr-FR/gateway/configuration)
