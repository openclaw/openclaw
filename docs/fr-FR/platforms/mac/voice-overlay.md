---
summary: "Lifecycle overlay voix quand wake-word et push-to-talk se chevauchent"
read_when:
  - Ajustement comportement overlay voix
title: "Overlay Voix"
---

# Lifecycle Overlay Voix (macOS)

Audience : contributeurs app macOS. Objectif : garder overlay voix prévisible quand wake-word et push-to-talk se chevauchent.

## Intent actuel

- Si overlay déjà visible depuis wake-word et utilisateur presse hotkey, session hotkey _adopte_ texte existant au lieu le reset. Overlay reste up pendant hotkey maintenu. Quand utilisateur relâche : envoyer si texte trimmé existe, sinon dismiss.
- Wake-word seul toujours auto-envoie sur silence ; push-to-talk envoie immédiatement sur release.

## Implémenté (Dec 9, 2025)

- Sessions overlay portent maintenant token per capture (wake-word ou push-to-talk). Mises à jour partial/final/send/dismiss/level droppées quand token ne correspond pas, évitant callbacks périmés.
- Push-to-talk adopte tout texte overlay visible comme préfixe (donc presser hotkey pendant overlay wake up garde texte et append nouvelle parole). Attend jusqu'à 1.5s pour transcript final avant fall back vers texte actuel.
- Logging chime/overlay émis à `info` dans catégories `voicewake.overlay`, `voicewake.ptt` et `voicewake.chime` (démarrage session, partial, final, send, dismiss, raison chime).

## Prochaines étapes

1. **VoiceSessionCoordinator (acteur)**
   - Possède exactement une `VoiceSession` à la fois.
   - API (token-based) : `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Drop callbacks portant tokens périmés (empêche anciens recognizers rouvrir overlay).

2. **VoiceSession (modèle)**
   - Champs : `token`, `source` (wakeWord|pushToTalk), texte committed/volatile, flags chime, timers (auto-send, idle), `overlayMode` (display|editing|sending), deadline cooldown.

3. **Binding Overlay**
   - `VoiceSessionPublisher` (`ObservableObject`) mirror session active dans SwiftUI.
   - `VoiceWakeOverlayView` rend uniquement via publisher ; ne mute jamais singletons globaux directement.

## Checklist Débogage

- Stream logs pendant reproduction overlay bloqué :

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

Voir aussi :

- [Voice Wake](/fr-FR/platforms/mac/voicewake)
- [App macOS](/fr-FR/platforms/macos)
- [Logging](/fr-FR/platforms/mac/logging)
