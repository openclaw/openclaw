---
summary: "Cycle de vie de la superposition vocale lorsque le mot d’activation et le push-to-talk se chevauchent"
read_when:
  - Ajustement du comportement de la superposition vocale
title: "Superposition vocale"
---

# Cycle de vie de la superposition vocale (macOS)

Public : contributeurs de l’application macOS. Objectif : maintenir une superposition vocale prévisible lorsque le mot d’activation et le push-to-talk se chevauchent.

## Intention actuelle

- Si la superposition est déjà visible via le mot d’activation et que l’utilisateur appuie sur le raccourci clavier, la session push-to-talk _adopte_ le texte existant au lieu de le réinitialiser. La superposition reste affichée tant que le raccourci est maintenu. Au relâchement : envoyer s’il existe du texte tronqué, sinon fermer.
- Le mot d’activation seul envoie toujours automatiquement après le silence ; le push-to-talk envoie immédiatement au relâchement.

## Implémenté (9 déc. 2025)

- Les sessions de superposition portent désormais un jeton par capture (mot d’activation ou push-to-talk). Les mises à jour partial/final/send/dismiss/level sont ignorées lorsque le jeton ne correspond pas, ce qui évite les rappels obsolètes.
- Le push-to-talk adopte tout texte de superposition visible comme préfixe (ainsi, appuyer sur le raccourci pendant que la superposition du mot d’activation est affichée conserve le texte et ajoute la nouvelle parole). Il attend jusqu’à 1,5 s un transcript final avant de revenir au texte courant.
- La journalisation des carillons/superpositions est émise à `info` dans les catégories `voicewake.overlay`, `voicewake.ptt` et `voicewake.chime` (début de session, partiel, final, envoi, fermeture, raison du carillon).

## Prochaines étapes

1. **VoiceSessionCoordinator (actor)**
   - Détient exactement un `VoiceSession` à la fois.
   - API (basée sur des jetons) : `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Lâche les callbacks qui portent des jetons obsolètes (empêche les anciens reconnaissants de rouvrir le recouvrement).
2. **VoiceSession (model)**
   - Champs : `token`, `source` (wakeWord|pushToTalk), texte validé/volatile, indicateurs de carillon, minuteurs (envoi auto, inactivité), `overlayMode` (display|editing|sending), échéance de cooldown.
3. **Liaison de la superposition**
   - `VoiceSessionPublisher` (`ObservableObject`) reflète la session active dans SwiftUI.
   - `VoiceWakeOverlayView` effectue le rendu uniquement via l’éditeur ; il ne modifie jamais directement des singletons globaux.
   - Les actions utilisateur de la superposition (`sendNow`, `dismiss`, `edit`) rappellent le coordinateur avec le jeton de session.
4. **Chemin d'envoi unifié**
   - À `endCapture` : si le texte tronqué est vide → fermer ; sinon `performSend(session:)` (joue le carillon d’envoi une fois, transfère, ferme).
   - Push-to-talk : pas de délai ; mot d’activation : délai optionnel pour l’envoi automatique.
   - Appliquer un court cooldown à l’exécution du mot d’activation après la fin du push-to-talk afin que le mot d’activation ne se redéclenche pas immédiatement.
5. **Journalisation**
   - Le coordinateur émet des journaux `.info` dans le sous-système `bot.molt`, catégories `voicewake.overlay` et `voicewake.chime`.
   - Événements clés : `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Liste de vérification de débogage

- Stream les logs tout en reproduisant une surcouche autocollante :

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Vérifiez qu’il n’y a qu’un seul jeton de session actif ; les rappels obsolètes doivent être ignorés par le coordinateur.

- Assurez-vous que le relâchement du push-to-talk appelle toujours `endCapture` avec le jeton actif ; si le texte est vide, attendez-vous à `dismiss` sans carillon ni envoi.

## Étapes de migration (suggestions)

1. Ajouter `VoiceSessionCoordinator`, `VoiceSession` et `VoiceSessionPublisher`.
2. Refactoriser `VoiceWakeRuntime` pour créer/mettre à jour/terminer des sessions au lieu de toucher directement `VoiceWakeOverlayController`.
3. Refactoriser `VoicePushToTalk` pour adopter les sessions existantes et appeler `endCapture` au relâchement ; appliquer le cooldown d’exécution.
4. Connecter `VoiceWakeOverlayController` à l’éditeur ; supprimer les appels directs depuis l’exécution/PTT.
5. Ajouter des tests d’intégration pour l’adoption de session, le cooldown et la fermeture lorsque le texte est vide.
