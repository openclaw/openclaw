---
summary: "Intégration Gmail avec Google Cloud Pub/Sub pour la réception push en temps réel"
read_when:
  - Configurer Gmail pour les notifications push en temps réel
  - Remplacer le polling Gmail par l'intégration Pub/Sub
title: "Gmail Pub/Sub (push)"
---

# Gmail Pub/Sub (intégration push)

OpenClaw supporte Gmail avec **Cloud Pub/Sub** pour une livraison de notifications push en temps réel, en
remplacement du polling. Quand Pub/Sub est configuré, OpenClaw reçoit des notifications instantanées pour
les nouveaux e-mails au lieu d'interroger périodiquement.

## Démarrage rapide

1. Créez un projet GCP avec l'API Gmail activée.
2. Créez un sujet et un abonnement Pub/Sub.
3. Configurez les identifiants de service account avec les permissions Pub/Sub.
4. Enregistrez le sujet avec Gmail (voir ci-dessous).
5. Ajoutez la config dans `~/.openclaw/config.json` sous `tools.gmail.pubsub`.
6. La Passerelle s'abonnera à `pubSubSubscriptionId` au démarrage et enregistrera automatiquement
   une montre Gmail si elle a expiré ou est manquante.

## Exemple de configuration

```json5
{
  tools: {
    gmail: {
      pubsub: {
        enabled: true,
        subscriptionId: "openclaw-gmail-sub",
        topicName: "openclaw-gmail-topic",
        projectId: "my-gcp-project",

        // Emplacement du fichier de clé de service account (recommandé)
        serviceAccountKeyPath: "~/.openclaw/credentials/gcp-service-account.json",

        // OU définir les identifiants inline (non recommandé)
        serviceAccount: {
          client_email: "openclaw@my-gcp-project.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\n...",
        },

        // Expire la montre Gmail et la réenregistre au démarrage (par défaut : false)
        expireWatchOnStartup: false,

        // Renouvellement optionnel de montre périodique (renouvelle 24h avant expiration)
        refreshWatch: true,
      },
    },
  },
}
```

`serviceAccountKeyPath` est recommandé pour la sécurité ; sinon, vous pouvez définir `serviceAccount` inline.

## Enregistrement du sujet avec Gmail

Avant que Gmail puisse publier vers votre sujet, le sujet doit être enregistré via `gmail.users.watch` :

```bash
# Via la CLI Gmail officielle
gmail watch add --topic-name=projects/my-gcp-project/topics/openclaw-gmail-topic

# Ou via curl (nécessite un token OAuth Gmail)
curl -X POST "https://gmail.googleapis.com/gmail/v1/users/me/watch" \
  -H "Authorization: Bearer <gmail_oauth_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "topicName": "projects/my-gcp-project/topics/openclaw-gmail-topic",
    "labelIds": ["INBOX"]
  }'
```

OpenClaw tente de réenregistrer automatiquement si la config `pubsub.refreshWatch` est vraie et
que la montre expire dans les 24h.

## Détails de l'abonnement

L'abonnement Pub/Sub doit exister dans votre projet GCP. OpenClaw crée un `PubSub`
client avec vos identifiants de service account et s'abonne à `subscriptionId`.

Le service account nécessite :

- `pubsub.subscriber` (pour recevoir les messages)
- `gmail.readonly` (si vous voulez qu'OpenClaw réenregistre automatiquement les montres)

Quand un message Pub/Sub arrive :

1. OpenClaw examine l'`historyId` et appelle `gmail.users.history.list` pour obtenir les nouveaux
   événements de boîte de réception.
2. Si un nouveau e-mail est détecté, l'outil Gmail traite comme d'habitude (respectant les préférences de notification
   - conditions du hook `gmail`).
3. Le message Pub/Sub est confirmé.

## Expiration et renouvellement de montre

Les montres Gmail expirent après **7 jours** par défaut. Si vous voulez qu'OpenClaw réenregistre automatiquement
la montre avant expiration :

- Définissez `refreshWatch: true`.
- Assurez-vous que le service account dispose des permissions OAuth Gmail `gmail.readonly`.
- OpenClaw vérifiera périodiquement et renouvellera la montre 24h avant expiration.

Sinon, la montre doit être manuellement réenregistrée tous les 7 jours.

`expireWatchOnStartup: true` est utile pour les environnements de test ou de dev : il force une expiration
immédiate et un réenregistrement de la montre au démarrage de la passerelle.

## Paramètres de configuration détaillés

Champs clés :

- `enabled` : active l'abonnement Pub/Sub (par défaut : false).
- `subscriptionId` : nom de l'abonnement Pub/Sub (sans préfixe de chemin de projet).
- `topicName` : nom du sujet complet (ex., `openclaw-gmail-topic` ou chemin complet).
- `projectId` : ID du projet GCP.
- `serviceAccountKeyPath` : chemin vers le fichier de clé du service account (recommandé).
- `serviceAccount` : objet de clé de service account inline (non recommandé).
- `refreshWatch` : renouvellement automatique de montre avant expiration (par défaut : false).
- `expireWatchOnStartup` : expire et réenregistre immédiatement au démarrage (par défaut : false).

## Dépannage

### "Pub/Sub n'abonne pas"

- Vérifiez que l'abonnement existe dans GCP : `gcloud pubsub subscriptions describe <sub>`.
- Confirmez que le service account a la permission `pubsub.subscriber`.
- Recherchez les erreurs Pub/Sub dans les journaux de passerelle.

### "Pas de notifications push"

- Vérifiez que la montre Gmail est enregistrée : appelez `gmail.users.getProfile` ou vérifiez via
  la Console API Gmail pour voir le statut de la montre.
- Les montres expirent après 7 jours ; utilisez `refreshWatch: true` pour le renouvellement automatique.

### "Erreurs d'authentification OAuth"

- Si vous utilisez `serviceAccountKeyPath`, assurez-vous que le chemin est correct et que le fichier JSON contient
  `client_email` et `private_key`.
- Si inline, vérifiez le format et les sauts de ligne de `private_key` (`\n`).
