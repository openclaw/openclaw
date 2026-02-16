---
summary: "États icône menu bar et animations pour OpenClaw sur macOS"
read_when:
  - Changement comportement icône menu bar
title: "Icône Menu Bar"
---

# États Icône Menu Bar

- **Idle :** Animation icône normale (clignement, wiggle occasionnel).
- **Paused :** Item statut utilise `appearsDisabled` ; pas motion.
- **Voice trigger (grandes oreilles) :** Détecteur voice wake appelle `AppState.triggerVoiceEars(ttl: nil)` quand wake word entendu, gardant `earBoostActive=true` pendant capture énoncé. Oreilles scale up (1.9x), obtiennent trous oreille circulaires pour lisibilité, puis drop via `stopVoiceEars()` après 1s silence. Uniquement déclenché depuis pipeline voix in-app.
- **Working (agent en cours) :** `AppState.isWorking=true` conduit micro-motion "tail/leg scurry" : wiggle leg plus rapide et offset léger pendant work in-flight. Actuellement togglé autour runs agent WebChat ; ajoutez même toggle autour autres tâches longues quand vous les câblez.

## Points Câblage

- Voice wake : runtime/tester appellent `AppState.triggerVoiceEars(ttl: nil)` sur trigger et `stopVoiceEars()` après 1s silence pour correspondre fenêtre capture.
- Activité agent : définir `AppStateStore.shared.setWorking(true/false)` autour spans work (déjà fait dans appel agent WebChat). Gardez spans courts et reset dans blocs `defer` pour éviter animations bloquées.

## Formes & Tailles

- Icône base dessinée dans `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Ear scale défaut à `1.0` ; boost voix définit `earScale=1.9` et toggle `earHoles=true` sans changer frame global (image template 18×18 pt rendue dans backing store Retina 36×36 px).
- Scurry utilise leg wiggle jusqu'à ~1.0 avec petit jiggle horizontal ; c'est additif à tout wiggle idle existant.

## Notes Comportementales

- Pas toggle CLI/broker externe pour ears/working ; gardez-le interne aux signaux propres app pour éviter flapping accidentel.
- Gardez TTLs courts (moins de 10s) donc icône retourne vers baseline rapidement si job hang.

Voir aussi :

- [Menu Bar](/fr-FR/platforms/mac/menu-bar)
- [App macOS](/fr-FR/platforms/macos)
- [Voice Wake](/fr-FR/platforms/mac/voicewake)
