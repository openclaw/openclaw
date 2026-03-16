---
summary: "Voice wake et modes push-to-talk plus détails routage dans app mac"
read_when:
  - Travail sur voice wake ou chemins PTT
title: "Voice Wake"
---

# Voice Wake & Push-to-Talk

## Modes

- **Mode Wake-word** (défaut) : recognizer Speech always-on attend tokens déclencheurs (`swabbleTriggerWords`). Sur correspondance démarre capture, montre overlay avec texte partiel et auto-envoie après silence.
- **Push-to-talk (Option Droite hold)** : maintenez touche Option droite pour capturer immédiatement—pas de trigger nécessaire. Overlay apparaît pendant maintien ; relâcher finalise et forward après court délai donc vous pouvez ajuster texte.

## Comportement Runtime (wake-word)

- Recognizer Speech vit dans `VoiceWakeRuntime`.
- Trigger ne déclenche que quand il y a **pause significative** entre wake word et mot suivant (~0.55s gap). Overlay/chime peuvent démarrer sur pause même avant début commande.
- Fenêtres silence : 2.0s quand parole coule, 5.0s si seulement trigger entendu.
- Stop dur : 120s pour prévenir sessions runaway.
- Debounce entre sessions : 350ms.
- Overlay conduit via `VoiceWakeOverlayController` avec coloration committed/volatile.
- Après envoi, recognizer redémarre proprement pour écouter prochain trigger.

## Invariants Lifecycle

- Si Voice Wake activé et permissions accordées, recognizer wake-word devrait écouter (sauf pendant capture push-to-talk explicite).
- Visibilité overlay (incluant dismiss manuel via bouton X) ne doit jamais empêcher recognizer de reprendre.

## Hardening

- Restart runtime wake n'est plus bloqué par visibilité overlay.
- Achèvement dismiss overlay déclenche `VoiceWakeRuntime.refresh(...)` via `VoiceSessionCoordinator`, donc X-dismiss manuel reprend toujours écoute.

## Spécifiques Push-to-Talk

- Détection hotkey utilise moniteur global `.flagsChanged` pour **Option Droite** (`keyCode 61` + `.option`). Nous observons uniquement événements (pas swallowing).
- Pipeline capture vit dans `VoicePushToTalk` : démarre Speech immédiatement, stream partiels vers overlay et appelle `VoiceWakeForwarder` sur release.
- Quand push-to-talk démarre nous pausons runtime wake-word pour éviter audio taps dueling ; redémarre automatiquement après release.
- Permissions : nécessite Microphone + Speech ; voir événements nécessite approbation Accessibility/Input Monitoring.

## Paramètres User-Facing

- Toggle **Voice Wake** : active runtime wake-word.
- **Hold Cmd+Fn to talk** : active moniteur push-to-talk. Désactivé sur macOS < 26.
- Pickers langue & mic, mètre niveau live, table trigger-word, tester (local-only ; ne forward pas).
- **Sounds** : chimes sur détection trigger et sur envoi ; défaut son système macOS "Glass".

## Comportement Forwarding

- Quand Voice Wake activé, transcripts forwarded vers gateway/agent actif (même mode local vs remote utilisé par reste app mac).
- Réponses livrées vers **provider main last-used** (WhatsApp/Telegram/Discord/WebChat).

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Permissions macOS](/fr-FR/platforms/mac/permissions)
- [Nœuds](/fr-FR/nodes/index)
