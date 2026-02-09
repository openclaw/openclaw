---
summary: "Logique de statut de la barre de menus et ce qui est présenté aux utilisateurs"
read_when:
  - Ajustement de l’interface de menu mac ou de la logique de statut
title: "Barre de menus"
---

# Logique de statut de la barre de menus

## Ce qui est affiché

- Nous affichons l’état de travail actuel de l’agent dans l’icône de la barre de menus et dans la première ligne de statut du menu.
- L’état de santé est masqué pendant que le travail est actif ; il réapparaît lorsque toutes les sessions sont inactives.
- Le bloc « Nodes » du menu liste uniquement les **appareils** (nœuds appairés via `node.list`), et non les entrées client/présence.
- Une section « Usage » apparaît sous Context lorsque des instantanés d’utilisation du fournisseur sont disponibles.

## Modèle d’état

- Sessions : les événements arrivent avec `runId` (par exécution) plus `sessionKey` dans la charge utile. La session « principale » est la clé `main` ; si elle est absente, nous revenons à la session mise à jour le plus récemment.
- Priorité : la session principale l’emporte toujours. Si la principale est active, son état est affiché immédiatement. Si la principale est inactive, la session non principale la plus récemment active est affichée. Nous n’alter­nons pas en cours d’activité ; nous basculons uniquement lorsque la session courante devient inactive ou que la principale devient active.
- Types d’activité :
  - `job` : exécution de commandes de haut niveau (`state: started|streaming|done|error`).
  - `tool` : `phase: start|result` avec `toolName` et `meta/args`.

## Enum IconState (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (remplacement de débogage)

### ActivityKind → glyphe

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- par défaut → 🛠️

### Mappage visuel

- `idle` : créature normale.
- `workingMain` : badge avec glyphe, teinte complète, animation de pattes « en travail ».
- `workingOther` : badge avec glyphe, teinte atténuée, pas de déplacement.
- `overridden` : utilise le glyphe/la teinte choisis indépendamment de l’activité.

## Texte de la ligne de statut (menu)

- Pendant que le travail est actif : `<Session role> · <activity label>`
  - Exemples : `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- À l’inactivité : retour au récapitulatif de santé.

## Ingestion des événements

- Source : événements `agent` du canal de contrôle (`ControlChannel.handleAgentEvent`).
- Champs analysés :
  - `stream: "job"` avec `data.state` pour démarrage/arrêt.
  - `stream: "tool"` avec `data.phase`, `name`, `meta`/`args` optionnels.
- Libellés :
  - `exec` : première ligne de `args.command`.
  - `read`/`write` : chemin raccourci.
  - `edit` : chemin plus type de modification déduit de `meta`/comptes de diff.
  - repli : nom de l’outil.

## Debug override

- Réglages ▸ Debug ▸ sélecteur « Icon override » :
  - `System (auto)` (par défaut)
  - `Working: main` (par type d’outil)
  - `Working: other` (par type d’outil)
  - `Idle`
- Stocké via `@AppStorage("iconOverride")` ; mappé vers `IconState.overridden`.

## Liste de vérification de test

- Déclencher un job de la session principale : vérifier que l’icône bascule immédiatement et que la ligne de statut affiche le libellé principal.
- Déclencher un job de session non principale lorsque la principale est inactive : l’icône/le statut affichent la non principale ; restent stables jusqu’à la fin.
- Démarrer la principale alors qu’une autre est active : l’icône bascule instantanément vers la principale.
- Rafales rapides d’outils : s’assurer que le badge ne scintille pas (délai de grâce TTL sur les résultats d’outils).
- La ligne de santé réapparaît une fois toutes les sessions inactives.
