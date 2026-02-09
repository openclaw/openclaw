---
summary: "Statut de prise en charge, capacites et configuration de Tlon/Urbit"
read_when:
  - Travail sur les fonctionnalites du canal Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon est une messagerie decentralisee construite sur Urbit. OpenClaw se connecte a votre vaisseau Urbit et peut
repondre aux Messages prives et aux messages de discussion de groupe. Les reponses de groupe necessitent par defaut une mention @ et peuvent
etre davantage restreintes via des listes d'autorisation.

Statut : pris en charge via plugin. Messages prives, mentions de groupe, reponses de fil et solution de repli media en texte seul
(URL ajoutee a la legende). Les reactions, les sondages et les televersements de medias natifs ne sont pas pris en charge.

## Plugin requis

Tlon est fourni sous forme de plugin et n’est pas inclus dans l’installation de base.

Installation via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/tlon
```

Depot local (lors d’une execution depuis un depot git) :

```bash
openclaw plugins install ./extensions/tlon
```

Details : [Plugins](/plugin)

## Configuration

1. Installez le plugin Tlon.
2. Rassemblez l’URL de votre vaisseau et le code de connexion.
3. Configurez `channels.tlon`.
4. Redemarrez la Gateway (passerelle).
5. Envoyez un Message prive au bot ou mentionnez-le dans un canal de groupe.

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

## Canaux de groupe

La decouverte automatique est activee par defaut. Vous pouvez egalement epingler des canaux manuellement :

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Desactiver la decouverte automatique :

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Controle d’acces

Liste d’autorisation des Messages prives (vide = tout autoriser) :

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Autorisation des groupes (restreinte par defaut) :

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

Utilisez-les avec `openclaw message send` ou une livraison via cron :

- Message prive : `~sampel-palnet` ou `dm/~sampel-palnet`
- Groupe : `chat/~host-ship/channel` ou `group:~host-ship/channel`

## Notes

- Les reponses de groupe necessitent une mention (par exemple `~your-bot-ship`) pour repondre.
- Reponses de fil : si le message entrant est dans un fil, OpenClaw repond dans le fil.
- Media : `sendMedia` bascule vers texte + URL (pas de televersement natif).
