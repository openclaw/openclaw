---
summary: "Dépannage rapide du niveau du canal avec les signatures d'échec par canal et corrections"
read_when:
  - Un canal se connecte mais les messages ne circulent pas
  - Vous avez besoin de vérifications spécifiques au canal avant la documentation du fournisseur profond
title: "Depannage des canaux"
---

# Depannage des canaux

Utilisez cette page quand un canal se connecte mais que le comportement est erroné.

## Échelle de commandes

Exécutez d'abord dans l'ordre :

```bash
openclaw doctor
openclaw channels status --probe
```

Base saine :

- `Runtime: en cours`
- `sonde RPC: ok`
- La sonde de canal montre connecté/prêt

## WhatsApp

### Signatures d'échec WhatsApp

| Symptôme                                      | Contrôle le plus rapide                                                                                                                                                                                                    | Correctif                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Connecté mais aucune réponse DM               | `liste d'appairage openclaw whatsapp`                                                                                                                                                                                      | Approuver l'expéditeur ou le changement de politique / liste d'autorisations de DM. |
| Messages de groupe ignorés                    | Vérifiez `requireMention` + modèles de mention dans la configuration                                                                                                                                                       | Mentionnez le bot ou relâchez la politique de mention pour ce groupe.               |
| Boucles de déconnexion/reconnexion aléatoires | Les journaux affichent `setMyCommands failed` → verifiez la connectivite HTTPS sortante et la joignabilite DNS vers `api.telegram.org` (courant sur des VPS verrouilles ou des proxys). | La reconnexion et la vérification des identifiants est saine.                       |

WhatsApp : [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Signatures d'échec de Telegram

| Symptôme                                       | Contrôle le plus rapide                                             | Correctif                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start` mais aucun flux de réponse utilisable | `openclaw pairing list telegram`                                    | Approuver l'appairage ou la modification de la politique de DM.                                                                                                                                                          |
| Bot en ligne mais le groupe reste silencieux   | Vérifier l'exigence de mention et le mode de confidentialité du bot | Désactiver le mode confidentialité pour la visibilité des groupes ou le bot de mention                                                                                                                                                   |
| Échecs d'envoi avec erreurs de réseau          | Inspecter les logs pour les échecs d'appel de l'API Telegram        | Si `api.telegram.org` se resout d’abord en IPv6 et que l’hote ne dispose pas de sortie IPv6, forcez IPv4 ou activez IPv6. Voir [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting). |

Telegram : [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Signatures d'échec de Discord

| Symptôme                                   | Contrôle le plus rapide                         | Correctif                                                                                 |
| ------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Bot en ligne mais aucune réponse de guilde | Correctifs rapides Telegram                     | Autoriser la guild/canal et vérifier l'intention du contenu du message.   |
| Messages de groupe ignorés                 | Journal de contrôle pour les gouttes de mention | Mentionnez le bot ou définissez la guild/channel `requireMention: false`. |
| Réponses DM manquantes                     | `discordance de la liste d'appairage openclaw`  | Approuver l'appairage du DM ou ajuster la politique du DM.                |

Discord : [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Signatures d'échec de Slack

| Symptôme                               | Contrôle le plus rapide                                       | Correctif                                                                                     |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Mode Socket connecté mais sans réponse | gpt-5.2-chat-latest                           | Vérifiez le jeton de l'application + le jeton de bot et les portées requises. |
| DMs bloqués                            | `openclaw pairing list slack`                                 | Approuver l'appairage ou le relâchement de la politique DM.                   |
| Message du salon ignoré                | Vérifiez `groupPolicy` et la liste des autorisations de salon | Autoriser le canal ou la politique de commutation à `open`.                   |

Enquete sur une mauvaise configuration du canal (intents, permissions, mode de confidentialite)

## iMessage et BlueBubbles

### Signatures d'échec iMessage et BlueBubbles

| Symptôme                                     | Contrôle le plus rapide                                                                | Correctif                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Aucun événement entrant                      | Vérifier la disponibilité du webhook/serveur et les autorisations des applications     | Corriger l'URL du webhook ou l'état du serveur BlueBubbles.           |
| Peut envoyer mais pas de réception sur macOS | Vérifiez les autorisations de confidentialité macOS pour l'automatisation des messages | Réaccorder les autorisations TCC et redémarrer le processus de canal. |
| Expéditeur de MP bloqué                      | `openclaw pairing list imessage` ou `openclaw pairing list bluebubbles`                | Approuver l'appairage ou la mise à jour de la liste d'autorisations.  |

Dépannage complet :

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- channels/troubleshooting.md

## Signal

### Signaux d'échec du signal

| Symptôme                                       | Contrôle le plus rapide                                                 | Correctif                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Démon joignable mais bot silencieux            | Canaux                                                                  | Vérifiez l'URL / le compte démon `signal-cli` et le mode réception. |
| DM bloqués                                     | `openclaw pairing list signal`                                          | Approuver l'expéditeur ou ajuster la politique de DM.               |
| Les réponses de groupe ne sont pas déclenchées | Vérifier les listes d'autorisations du groupe et les modèles de mention | Ajouter l'expéditeur/groupe ou la porte en douceur.                 |

Raccourcis de depannage specifiques aux canaux (Discord/Telegram/WhatsApp)

## Matrix

### Signatures d'échec de la matrice

| Symptôme                                      | Contrôle le plus rapide                                                                                                                                                                                                                                       | Correctif                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Connecté mais ignore les messages de la salle | `channels status --probe` affiche des avertissements lorsqu’il peut detecter des mauvaises configurations courantes de canal, et inclut de petits controles en direct (identifiants, certaines permissions/appartenances). | Vérifiez `groupPolicy` et la liste d'autorisations de salle.                         |
| Les DMs ne traitent pas                       | `openclaw pairing list matrix`                                                                                                                                                                                                                                | Approuver l'expéditeur ou ajuster la politique de DM.                                |
| Échec du chiffrement des salles               | Vérifier les paramètres de cryptage et de cryptage                                                                                                                                                                                                            | Activer la prise en charge du chiffrement et la salle de rejointure/synchronisation. |

Dépannage complet : [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
