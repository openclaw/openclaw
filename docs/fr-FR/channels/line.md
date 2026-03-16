---
summary: "Configuration plugin LINE Messaging API, config et utilisation"
read_when:
  - Vous voulez connecter OpenClaw à LINE
  - Vous avez besoin configuration webhook LINE + identifiants
  - Vous voulez options messages spécifiques LINE
title: LINE
---

# LINE (plugin)

LINE se connecte à OpenClaw via l'API LINE Messaging. Le plugin fonctionne comme récepteur webhook sur la passerelle et utilise votre jeton d'accès canal + secret canal pour l'authentification.

Statut : supporté via plugin. Messages directs, chats de groupe, médias, emplacements, messages Flex, messages template et réponses rapides sont supportés. Réactions et fils ne sont pas supportés.

## Plugin requis

Installez le plugin LINE :

```bash
openclaw plugins install @openclaw/line
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/line
```

## Configuration

1. Créez un compte LINE Developers et ouvrez la Console :
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Créez (ou choisissez) un Fournisseur et ajoutez un canal **Messaging API**.
3. Copiez le **jeton d'accès canal** et le **secret canal** depuis les paramètres du canal.
4. Activez **Utiliser webhook** dans les paramètres Messaging API.
5. Définissez l'URL webhook sur votre point de terminaison passerelle (HTTPS requis) :

```
https://gateway-host/line/webhook
```

La passerelle répond à la vérification webhook LINE (GET) et aux événements entrants (POST).
Si vous avez besoin d'un chemin personnalisé, définissez `channels.line.webhookPath` ou
`channels.line.accounts.<id>.webhookPath` et mettez à jour l'URL en conséquence.

## Configurer

Configuration minimale :

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Variables d'environnement (compte par défaut uniquement) :

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Fichiers jeton/secret :

```json5
{
  channels: {
    line: {
      tokenFile: "/chemin/vers/line-token.txt",
      secretFile: "/chemin/vers/line-secret.txt",
    },
  },
}
```

Comptes multiples :

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Contrôle d'accès

Les messages directs utilisent l'appairage par défaut. Les expéditeurs inconnus obtiennent un code d'appairage et leurs messages sont ignorés jusqu'à approbation.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listes d'autorisation et politiques :

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: IDs utilisateur LINE autorisés pour DM
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: IDs utilisateur LINE autorisés pour groupes
- Remplacements par groupe : `channels.line.groups.<groupId>.allowFrom`

Les IDs LINE sont sensibles à la casse. Les IDs valides ressemblent à :

- Utilisateur : `U` + 32 caractères hexadécimaux
- Groupe : `C` + 32 caractères hexadécimaux
- Salle : `R` + 32 caractères hexadécimaux

## Comportement des messages

- Le texte est découpé à 5000 caractères.
- Le formatage Markdown est supprimé ; les blocs de code et tableaux sont convertis en cartes Flex quand c'est possible.
- Les réponses en streaming sont mises en tampon ; LINE reçoit des morceaux complets avec une animation de chargement pendant que l'agent travaille.
- Les téléchargements de médias sont limités par `channels.line.mediaMaxMb` (par défaut 10).

## Données canal (messages enrichis)

Utilisez `channelData.line` pour envoyer réponses rapides, emplacements, cartes Flex ou messages template.

```json5
{
  text: "Voici pour vous",
  channelData: {
    line: {
      quickReplies: ["Statut", "Aide"],
      location: {
        title: "Bureau",
        address: "123 Rue Principale",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Carte de statut",
        contents: {
          /* Charge utile Flex */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Continuer ?",
        confirmLabel: "Oui",
        confirmData: "yes",
        cancelLabel: "Non",
        cancelData: "no",
      },
    },
  },
}
```

Le plugin LINE fournit aussi une commande `/card` pour les préréglages de messages Flex :

```
/card info "Bienvenue" "Merci de nous rejoindre !"
```

## Dépannage

- **La vérification webhook échoue :** assurez-vous que l'URL webhook est HTTPS et que le `channelSecret` correspond à la console LINE.
- **Aucun événement entrant :** confirmez que le chemin webhook correspond à `channels.line.webhookPath` et que la passerelle est accessible depuis LINE.
- **Erreurs de téléchargement média :** augmentez `channels.line.mediaMaxMb` si le média dépasse la limite par défaut.

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
