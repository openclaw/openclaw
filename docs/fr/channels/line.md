---
summary: "Configuration, paramétrage et utilisation du plugin LINE Messaging API"
read_when:
  - Vous souhaitez connecter OpenClaw à LINE
  - Vous avez besoin de la configuration des webhooks et des identifiants LINE
  - Vous souhaitez utiliser des options de message spécifiques à LINE
title: LINE
---

# LINE (plugin)

LINE se connecte à OpenClaw via l’API LINE Messaging. Le plugin s’exécute comme un
récepteur de webhook sur la Gateway (passerelle) et utilise votre jeton d’accès de
canal et le secret de canal pour l’authentification.

Statut : pris en charge via plugin. Les messages privés, discussions de groupe,
médias, localisations, messages Flex, messages de modèles et réponses rapides sont
pris en charge. Les réactions et les fils de discussion ne sont pas pris en charge.

## Plugin requis

Installez le plugin LINE :

```bash
openclaw plugins install @openclaw/line
```

Dépôt local (lorsque l’exécution se fait depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/line
```

## Configuration

1. Créez un compte LINE Developers et ouvrez la Console :
   https://developers.line.biz/console/
2. Créez (ou sélectionnez) un fournisseur et ajoutez un canal **Messaging API**.
3. Copiez le **Channel access token** et le **Channel secret** depuis les paramètres du canal.
4. Activez **Use webhook** dans les paramètres de la Messaging API.
5. Définissez l’URL du webhook vers le point de terminaison de votre Gateway (passerelle) (HTTPS requis) :

```
https://gateway-host/line/webhook
```

La Gateway (passerelle) répond à la vérification de webhook de LINE (GET) et aux
événements entrants (POST).
Si vous avez besoin d’un chemin personnalisé, définissez
`channels.line.webhookPath` ou `channels.line.accounts.<id>.webhookPath` et mettez l’URL à jour en conséquence.

## Configurer

Configuration minimale :

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

Variables d’environnement (compte par défaut uniquement) :

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Fichiers de jeton/secret :

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Comptes multiples :

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

## Contrôle d’accès

Les messages privés utilisent par défaut l’appairage. Les expéditeurs inconnus
reçoivent un code d’appairage et leurs messages sont ignorés jusqu’à approbation.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listes d’autorisation et politiques :

- `channels.line.dmPolicy` : `pairing | allowlist | open | disabled`
- `channels.line.allowFrom` : identifiants utilisateur LINE autorisés pour les messages privés
- `channels.line.groupPolicy` : `allowlist | open | disabled`
- `channels.line.groupAllowFrom` : identifiants utilisateur LINE autorisés pour les groupes
- Remplacements par groupe : `channels.line.groups.<groupId>.allowFrom`

Les identifiants LINE sont sensibles à la casse. Les identifiants valides ressemblent à :

- Utilisateur : `U` + 32 caractères hexadécimaux
- Groupe : `C` + 32 caractères hexadécimaux
- Salon : `R` + 32 caractères hexadécimaux

## Comportement des messages

- Le texte est segmenté par blocs de 5 000 caractères.
- La mise en forme Markdown est supprimée ; les blocs de code et les tableaux sont
  convertis en cartes Flex lorsque c’est possible.
- Les réponses en streaming sont mises en mémoire tampon ; LINE reçoit des blocs
  complets avec une animation de chargement pendant que l’agent travaille.
- Les téléchargements de médias sont limités par `channels.line.mediaMaxMb` (par défaut : 10).

## Données de canal (messages enrichis)

Utilisez `channelData.line` pour envoyer des réponses rapides, des localisations, des
cartes Flex ou des messages de modèles.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Le plugin LINE fournit également une commande `/card` pour des préréglages de
messages Flex :

```
/card info "Welcome" "Thanks for joining!"
```

## Problemes courants

- **Échec de la vérification du webhook :** assurez-vous que l’URL du webhook est en
  HTTPS et que `channelSecret` correspond à la console LINE.
- **Aucun événement entrant :** confirmez que le chemin du webhook correspond à
  `channels.line.webhookPath` et que la Gateway (passerelle) est accessible depuis LINE.
- **Erreurs de téléchargement de médias :** augmentez `channels.line.mediaMaxMb` si les médias
  dépassent la limite par défaut.
