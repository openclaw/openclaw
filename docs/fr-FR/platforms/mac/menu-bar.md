---
summary: "Logique statut menu bar et ce qui est surfacé aux utilisateurs"
read_when:
  - Ajustement UI menu mac ou logique statut
title: "Menu Bar"
---

# Logique Statut Menu Bar

## Ce qui est montré

- Nous surfaceons état travail agent actuel dans icône menu bar et dans première rangée statut du menu.
- Statut santé caché pendant travail actif ; retourne quand toutes sessions sont idle.
- Bloc "Nœuds" dans menu liste **appareils** uniquement (nœuds appairés via `node.list`), pas entrées client/présence.
- Section "Usage" apparaît sous Context quand snapshots usage provider disponibles.

## Modèle État

- Sessions : événements arrivent avec `runId` (per-run) plus `sessionKey` dans payload. Session "main" est clé `main` ; si absente, nous tombons back vers session mise à jour plus récemment.
- Priorité : main gagne toujours. Si main active, son état montré immédiatement. Si main idle, session non-main active plus récemment montrée. Nous ne flip-flop pas mid-activité ; switchons uniquement quand session actuelle va idle ou main devient active.
- Types activité :
  - `job` : exécution commande high-level (`state: started|streaming|done|error`).
  - `tool` : `phase: start|result` avec `toolName` et `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (override debug)

### ActivityKind → glyphe

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- défaut → 🛠️

### Mapping Visuel

- `idle` : critter normal.
- `workingMain` : badge avec glyphe, tint complet, animation leg "working".
- `workingOther` : badge avec glyphe, tint muted, pas scurry.
- `overridden` : utilise glyphe/tint choisi indépendamment activité.

## Texte rangée statut (menu)

- Pendant travail actif : `<Session role> · <activity label>`
- Quand idle : statut santé affiché.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Santé](/fr-FR/platforms/mac/health)
- [Status](/fr-FR/cli/status)
