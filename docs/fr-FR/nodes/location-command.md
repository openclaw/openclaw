---
summary: "Commande location pour nœuds (location.get), modes permission et comportement background"
read_when:
  - Ajout support nœud location ou UI permissions
  - Design location background + flux push
title: "Commande Location"
---

# Commande Location (nœuds)

## TL;DR

- `location.get` est commande nœud (via `node.invoke`).
- Désactivé par défaut.
- Paramètres utilisent sélecteur : Off / While Using / Always.
- Toggle séparé : Precise Location.

## Pourquoi sélecteur (pas juste switch)

Permissions OS sont multi-niveaux. Nous pouvons exposer sélecteur in-app, mais OS décide toujours accord réel.

- iOS/macOS : utilisateur peut choisir **While Using** ou **Always** dans prompts système/Réglages. App peut demander upgrade, mais OS peut nécessiter Réglages.
- Android : location background est permission séparée ; sur Android 10+ nécessite souvent flux Réglages.
- Location précise est accord séparé (iOS 14+ "Precise", Android "fine" vs "coarse").

Sélecteur dans UI conduit mode demandé ; accord réel vit dans réglages OS.

## Modèle Paramètres

Per dispositif nœud :

- `location.enabledMode` : `off | whileUsing | always`
- `location.preciseEnabled` : bool

Comportement UI :

- Sélectionner `whileUsing` demande permission foreground.
- Sélectionner `always` assure d'abord `whileUsing`, puis demande background (ou envoie utilisateur vers Réglages si requis).
- Si OS refuse niveau demandé, revenir vers niveau accordé le plus haut et montrer statut.

## Mapping Permissions (node.permissions)

Optionnel. Nœud macOS rapporte `location` via map permissions ; iOS/Android peuvent l'omettre.

## Commande : `location.get`

Appelée via `node.invoke`.

Params :

- `accuracy` : `best | nearestTenMeters | hundredMeters | kilometer | threeKilometers` (optionnel)
- `timeout` : millisecondes (optionnel)

Voir aussi :

- [Nœuds](/fr-FR/nodes/index)
- [Permissions](/fr-FR/platforms/mac/permissions)
- [App iOS](/fr-FR/platforms/ios)
