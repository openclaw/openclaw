---
summary: "États et animations de l’icône de la barre de menus pour OpenClaw sur macOS"
read_when:
  - Modification du comportement de l’icône de la barre de menus
title: "Icône de la barre de menus"
---

# États de l’icône de la barre de menus

Auteur : steipete · Mis à jour : 2025-12-06 · Portée : application macOS (`apps/macos`)

- **Inactif :** Animation normale de l’icône (clignotement, léger dandinement occasionnel).
- **En pause :** L’élément de statut utilise `appearsDisabled` ; aucun mouvement.
- **Déclenchement vocal (grandes oreilles) :** Le détecteur de réveil vocal appelle `AppState.triggerVoiceEars(ttl: nil)` lorsque le mot-clé est entendu, en maintenant `earBoostActive=true` pendant la capture de l’énoncé. Les oreilles s’agrandissent (1,9×), obtiennent des trous d’oreilles circulaires pour la lisibilité, puis retombent via `stopVoiceEars()` après 1 s de silence. Déclenché uniquement depuis le pipeline vocal intégré à l’application.
- **En cours (agent en exécution) :** `AppState.isWorking=true` pilote une micro‑animation de « course de queue/pattes » : dandinement des pattes plus rapide et léger décalage pendant l’exécution du travail. Actuellement activé autour des exécutions de l’agent WebChat ; ajoutez le même basculement autour d’autres tâches longues lorsque vous les raccorderez.

Points de câblage

- Réveil vocal : les appels runtime/tester appellent `AppState.triggerVoiceEars(ttl: nil)` au déclenchement et `stopVoiceEars()` après 1 s de silence pour correspondre à la fenêtre de capture.
- Activité de l’agent : définir `AppStateStore.shared.setWorking(true/false)` autour des plages de travail (déjà fait dans l’appel de l’agent WebChat). Gardez des plages courtes et réinitialisez dans des blocs `defer` pour éviter les animations bloquées.

Formes et tailles

- Icône de base dessinée dans `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- L’échelle des oreilles par défaut est `1.0` ; l’amplification vocale définit `earScale=1.9` et bascule `earHoles=true` sans modifier le cadre global (image modèle 18×18 pt rendue dans un support Retina 36×36 px).
- Scurry utilise des wiggle de jambe jusqu'à ~1.0 avec un petit jiggle horizontal ; il est additif à n'importe quelle wiggle inactive existante.

Notes comportementales

- Aucun basculement CLI/courtier externe pour les oreilles/le travail ; gardez cela interne aux signaux propres de l’application afin d’éviter des battements accidentels.
- Gardez des TTL courts (&lt;10 s) afin que l’icône revienne rapidement à l’état de base si une tâche se bloque.
