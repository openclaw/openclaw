---
summary: "Sémantique des réactions partagée entre les canaux"
read_when:
  - Travail sur les réactions dans n'importe quel canal
title: "Réactions"
---

# Outils de réaction

Sémantique des réactions partagée entre les canaux :

- `emoji` est requis lors de l'ajout d'une réaction.
- `emoji=""` supprime la ou les réaction(s) du bot lorsque supporté.
- `remove: true` supprime l'emoji spécifié lorsque supporté (nécessite `emoji`).

Notes par canal :

- **Discord/Slack** : `emoji` vide supprime toutes les réactions du bot sur le message ; `remove: true` supprime uniquement cet emoji.
- **Google Chat** : `emoji` vide supprime les réactions de l'application sur le message ; `remove: true` supprime uniquement cet emoji.
- **Telegram** : `emoji` vide supprime les réactions du bot ; `remove: true` supprime également les réactions mais nécessite toujours un `emoji` non vide pour la validation de l'outil.
- **WhatsApp** : `emoji` vide supprime la réaction du bot ; `remove: true` correspond à un emoji vide (nécessite toujours `emoji`).
- **Signal** : les notifications de réaction entrantes émettent des événements système lorsque `channels.signal.reactionNotifications` est activé.
