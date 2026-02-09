---
summary: "Sémantique des reactions partagee entre les canaux"
read_when:
  - Travail sur les reactions dans n'importe quel canal
title: "Reactions"
---

# Outils de reaction

Sémantique de reaction partagee entre les canaux :

- `emoji` est requis lors de l'ajout d'une reaction.
- `emoji=""` supprime la ou les reactions du bot lorsque pris en charge.
- `remove: true` supprime l'emoji specifie lorsque pris en charge (necessite `emoji`).

Notes par canal :

- **Discord/Slack** : un `emoji` vide supprime toutes les reactions du bot sur le message ; `remove: true` supprime uniquement cet emoji.
- **Google Chat** : un `emoji` vide supprime les reactions de l'application sur le message ; `remove: true` supprime uniquement cet emoji.
- **Telegram** : un `emoji` vide supprime les reactions du bot ; `remove: true` supprime egalement les reactions mais requiert toujours un `emoji` non vide pour la validation de l'outil.
- **WhatsApp** : un `emoji` vide supprime la reaction du bot ; `remove: true` correspond a un emoji vide (necessite toujours `emoji`).
- **Signal** : les notifications de reaction entrantes emettent des evenements systeme lorsque `channels.signal.reactionNotifications` est active.
