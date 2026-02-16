---
summary: "UI paramètres Compétences macOS et statut backed passerelle"
read_when:
  - Mise à jour UI paramètres Compétences macOS
  - Changement gating compétences ou comportement install
title: "Compétences"
---

# Compétences (macOS)

L'app macOS surface compétences OpenClaw via passerelle ; ne parse pas compétences localement.

## Source données

- `skills.status` (passerelle) retourne toutes compétences plus éligibilité et exigences manquantes (incluant blocs allowlist pour compétences bundled).
- Exigences dérivées depuis `metadata.openclaw.requires` dans chaque `SKILL.md`.

## Actions Install

- `metadata.openclaw.install` définit options install (brew/node/go/uv).
- App appelle `skills.install` pour exécuter installers sur hôte passerelle.
- Passerelle surface uniquement un installer préféré quand multiples fournis (brew quand disponible, sinon node manager depuis `skills.install`, défaut npm).

## Env/Clés API

- App stocke clés dans `~/.openclaw/openclaw.json` sous `skills.entries.<skillKey>`.
- `skills.update` patche `enabled`, `apiKey` et `env`.

## Mode Remote

- Install + mises à jour config arrivent sur hôte passerelle (pas Mac local).

## UI

Onglet Compétences dans app macOS montre :

- Liste compétences avec statut (activé/désactivé)
- Exigences manquantes
- Boutons install pour dépendances manquantes
- Champs input pour clés API

Voir aussi :

- [Compétences](/fr-FR/tools/skills)
- [Création Compétences](/fr-FR/tools/creating-skills)
- [App macOS](/fr-FR/platforms/macos)
