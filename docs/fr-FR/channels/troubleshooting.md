---
summary: "Dépannage rapide au niveau canal avec signatures d'échec par canal et corrections"
read_when:
  - Le transport du canal dit connecté mais les réponses échouent
  - Vous avez besoin de vérifications spécifiques au canal avant les docs de fournisseur profondes
title: "Dépannage des Canaux"
---

# Dépannage des canaux

Utilisez cette page quand un canal se connecte mais le comportement est incorrect.

## Échelle de commandes

Exécutez-les dans l'ordre d'abord :

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Base de référence saine :

- `Runtime: running`
- `RPC probe: ok`
- La sonde du canal montre connecté/prêt

## WhatsApp

### Signatures d'échec WhatsApp

| Symptôme                                      | Vérification la plus rapide                       | Correction                                                             |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Connecté mais pas de réponses DM              | `openclaw pairing list whatsapp`                  | Approuver l'expéditeur ou changer politique/liste blanche DM.          |
| Messages de groupe ignorés                    | Vérifier `requireMention` + motifs mention config | Mentionner le bot ou assouplir la politique de mention pour ce groupe. |
| Déconnexion/boucles de reconnexion aléatoires | `openclaw channels status --probe` + logs         | Se reconnecter et vérifier que le répertoire credentials est sain.     |

Dépannage complet : [/fr-FR/channels/whatsapp#troubleshooting-quick](/fr-FR/channels/whatsapp#troubleshooting-quick)

## Telegram

### Signatures d'échec Telegram

| Symptôme                                        | Vérification la plus rapide                       | Correction                                                                                |
| ----------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/start` mais pas de flux de réponse utilisable | `openclaw pairing list telegram`                  | Approuver l'appairage ou changer la politique DM.                                         |
| Bot en ligne mais groupe reste silencieux       | Vérifier exigence de mention et mode privé du bot | Désactiver le mode privé pour visibilité de groupe ou mentionner le bot.                  |
| Échecs d'envoi avec erreurs réseau              | Inspecter logs pour échecs d'appel API Telegram   | Corriger routage DNS/IPv6/proxy vers `api.telegram.org`.                                  |
| Mis à jour et liste blanche vous bloque         | `openclaw security audit` et config allowlists    | Exécuter `openclaw doctor --fix` ou remplacer `@username` avec IDs expéditeur numériques. |

Dépannage complet : [/fr-FR/channels/telegram#troubleshooting](/fr-FR/channels/telegram#troubleshooting)

## Discord

### Signatures d'échec Discord

| Symptôme                                 | Vérification la plus rapide                    | Correction                                                              |
| ---------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Bot en ligne mais pas de réponses guilde | `openclaw channels status --probe`             | Autoriser guilde/canal et vérifier intention de contenu de message.     |
| Messages de groupe ignorés               | Vérifier logs pour abandons de blocage mention | Mentionner le bot ou définir `requireMention: false` pour guilde/canal. |
| Réponses DM manquantes                   | `openclaw pairing list discord`                | Approuver appairage DM ou ajuster politique DM.                         |

Dépannage complet : [/fr-FR/channels/discord#troubleshooting](/fr-FR/channels/discord#troubleshooting)

## Slack

### Signatures d'échec Slack

| Symptôme                                  | Vérification la plus rapide                   | Correction                                           |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Mode socket connecté mais pas de réponses | `openclaw channels status --probe`            | Vérifier token app + token bot et scopes requis.     |
| DM bloqués                                | `openclaw pairing list slack`                 | Approuver appairage ou assouplir politique DM.       |
| Message de canal ignoré                   | Vérifier `groupPolicy` et liste blanche canal | Autoriser le canal ou changer politique vers `open`. |

Dépannage complet : [/fr-FR/channels/slack#troubleshooting](/fr-FR/channels/slack#troubleshooting)

## iMessage et BlueBubbles

### Signatures d'échec iMessage et BlueBubbles

| Symptôme                                 | Vérification la plus rapide                                                | Correction                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Pas d'événements entrants                | Vérifier accessibilité webhook/serveur et permissions app                  | Corriger URL webhook ou état serveur BlueBubbles.          |
| Peut envoyer mais pas recevoir sur macOS | Vérifier permissions de confidentialité macOS pour automatisation Messages | Re-accorder permissions TCC et redémarrer processus canal. |
| Expéditeur DM bloqué                     | `openclaw pairing list imessage` ou `openclaw pairing list bluebubbles`    | Approuver appairage ou mettre à jour liste blanche.        |

Dépannage complet :

- [/fr-FR/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/fr-FR/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/fr-FR/channels/bluebubbles#troubleshooting](/fr-FR/channels/bluebubbles#troubleshooting)

## Signal

### Signatures d'échec Signal

| Symptôme                                 | Vérification la plus rapide                     | Correction                                                    |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Daemon accessible mais bot silencieux    | `openclaw channels status --probe`              | Vérifier URL/compte daemon `signal-cli` et mode de réception. |
| DM bloqué                                | `openclaw pairing list signal`                  | Approuver expéditeur ou ajuster politique DM.                 |
| Réponses de groupe ne se déclenchent pas | Vérifier liste blanche groupe et motifs mention | Ajouter expéditeur/groupe ou assouplir le blocage.            |

Dépannage complet : [/fr-FR/channels/signal#troubleshooting](/fr-FR/channels/signal#troubleshooting)

## Matrix

### Signatures d'échec Matrix

| Symptôme                                   | Vérification la plus rapide                         | Correction                                                      |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| Connecté mais ignore les messages de salon | `openclaw channels status --probe`                  | Vérifier `groupPolicy` et liste blanche de salon.               |
| DM ne sont pas traités                     | `openclaw pairing list matrix`                      | Approuver expéditeur ou ajuster politique DM.                   |
| Salons chiffrés échouent                   | Vérifier module crypto et paramètres de chiffrement | Activer support du chiffrement et rejoindre/synchroniser salon. |

Dépannage complet : [/fr-FR/channels/matrix#troubleshooting](/fr-FR/channels/matrix#troubleshooting)
