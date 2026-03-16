---
summary: "Statut du support Tlon/Urbit, capacités et configuration"
read_when:
  - Travail sur les fonctionnalités du canal Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon est une messagerie décentralisée construite sur Urbit. OpenClaw se connecte à votre vaisseau Urbit et peut répondre aux DM et messages de chat de groupe. Les réponses de groupe nécessitent une mention @ par défaut et peuvent être davantage restreintes via des allowlists.

Statut : supporté via plugin. DM, mentions de groupe, réponses de fil, et fallback média texte uniquement (URL ajoutée à la légende). Réactions, sondages et téléchargements média natifs non supportés.

## Plugin requis

Tlon est livré en tant que plugin et n'est pas inclus dans l'installation de base.

Installation via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/tlon
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/tlon
```

Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration

1. Installer le plugin Tlon.
2. Rassembler l'URL de votre vaisseau et le code de connexion.
3. Configurer `channels.tlon`.
4. Redémarrer la passerelle.
5. Envoyer un DM au bot ou le mentionner dans un canal de groupe.

Configuration minimale (compte unique) :

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

URLs de vaisseau privé/LAN (avancé) :

Par défaut, OpenClaw bloque les noms d'hôtes privés/internes et les plages IP pour ce plugin (durcissement SSRF).
Si l'URL de votre vaisseau est sur un réseau privé (par exemple `http://192.168.1.50:8080` ou `http://localhost:8080`),
vous devez explicitement opter :

```json5
{
  channels: {
    tlon: {
      allowPrivateNetwork: true,
    },
  },
}
```

## Canaux de groupe

L'auto-découverte est activée par défaut. Vous pouvez également épingler les canaux manuellement :

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Désactiver l'auto-découverte :

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Contrôle d'accès

Allowlist DM (vide = autoriser tous) :

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Autorisation de groupe (restreinte par défaut) :

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Cibles de livraison (CLI/cron)

Utilisez celles-ci avec `openclaw message send` ou la livraison cron :

- DM : `~sampel-palnet` ou `dm/~sampel-palnet`
- Groupe : `chat/~host-ship/channel` ou `group:~host-ship/channel`

## Remarques

- Les réponses de groupe nécessitent une mention (par ex. `~your-bot-ship`) pour répondre.
- Réponses de fil : si le message entrant est dans un fil, OpenClaw répond dans le fil.
- Média : `sendMedia` revient à texte + URL (pas de téléchargement natif).
