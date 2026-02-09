---
summary: "Commande de localisation pour les nœuds (location.get), modes d’autorisation et comportement en arrière-plan"
read_when:
  - Ajout de la prise en charge du nœud de localisation ou de l’interface des autorisations
  - Conception des flux de localisation en arrière-plan + push
title: "Commande de localisation"
---

# Commande de localisation (nœuds)

## TL;DR

- `location.get` est une commande de nœud (via `node.invoke`).
- Désactivée par défaut.
- Les paramètres utilisent un sélecteur : Désactivé / Lors de l’utilisation / Toujours.
- Bascule séparée : Localisation précise.

## Pourquoi un sélecteur (et pas seulement un interrupteur)

Les autorisations du système d’exploitation sont multiniveaux. Nous pouvons exposer un sélecteur dans l’application, mais le système d’exploitation décide toujours de l’autorisation effective.

- iOS/macOS : l’utilisateur peut choisir **Lors de l’utilisation** ou **Toujours** dans les invites système / Réglages. L’application peut demander une mise à niveau, mais le système peut exiger un passage par les Réglages.
- Android : la localisation en arrière-plan est une autorisation distincte ; sur Android 10+, elle nécessite souvent un flux via les Réglages.
- La localisation précise est une autorisation distincte (iOS 14+ « Précise », Android « fine » vs « coarse »).

Le sélecteur dans l’interface pilote le mode demandé ; l’autorisation réelle réside dans les réglages du système d’exploitation.

## Modèle de paramètres

Par appareil de nœud :

- `location.enabledMode` : `off | whileUsing | always`
- `location.preciseEnabled` : bool

Comportement de l’interface :

- La sélection de `whileUsing` demande l’autorisation au premier plan.
- La sélection de `always` vérifie d’abord `whileUsing`, puis demande l’arrière-plan (ou envoie l’utilisateur vers les Réglages si requis).
- Si le système d’exploitation refuse le niveau demandé, revenir au niveau le plus élevé accordé et afficher l’état.

## Mappage des autorisations (node.permissions)

Optionnel. Le nœud macOS rapporte `location` via la carte des autorisations ; iOS/Android peuvent l’omettre.

## Commande : `location.get`

Appelée via `node.invoke`.

Paramètres (suggestions) :

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Charge utile de réponse :

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Erreurs (codes stables) :

- `LOCATION_DISABLED` : le sélecteur est désactivé.
- `LOCATION_PERMISSION_REQUIRED` : autorisation manquante pour le mode demandé.
- `LOCATION_BACKGROUND_UNAVAILABLE` : l’application est en arrière-plan mais seul « Lors de l’utilisation » est autorisé.
- `LOCATION_TIMEOUT` : aucun correctif dans le temps imparti.
- `LOCATION_UNAVAILABLE` : défaillance système / aucun fournisseur.

## Comportement en arrière-plan (futur)

Objectif : le modèle peut demander la localisation même lorsque le nœud est en arrière-plan, mais uniquement lorsque :

- L’utilisateur a sélectionné **Toujours**.
- Le système d’exploitation accorde la localisation en arrière-plan.
- L’application est autorisée à s’exécuter en arrière-plan pour la localisation (mode arrière-plan iOS / service au premier plan Android ou autorisation spéciale).

Flux déclenché par push (futur) :

1. La Gateway (passerelle) envoie un push au nœud (push silencieux ou données FCM).
2. Le nœud se réveille brièvement et demande la localisation à l’appareil.
3. Le nœud transfère la charge utile à la Gateway (passerelle).

Notes :

- iOS : autorisation « Toujours » + mode de localisation en arrière-plan requis. Les push silencieux peuvent être limités ; prévoir des échecs intermittents.
- Android : la localisation en arrière-plan peut nécessiter un service au premier plan ; sinon, prévoir un refus.

## Intégration modèle/outillage

- Surface d’outils : l’outil `nodes` ajoute l’action `location_get` (nœud requis).
- CLI : `openclaw nodes location get --node <id>`.
- Recommandations pour les agents : n’appeler que lorsque l’utilisateur a activé la localisation et comprend la portée.

## Texte UX (suggestions)

- Désactivé : « Le partage de localisation est désactivé. »
- Lors de l’utilisation : « Uniquement lorsque OpenClaw est ouvert. »
- Toujours : « Autoriser la localisation en arrière-plan. Nécessite une autorisation système.
- Précise : « Utiliser la localisation GPS précise. Désactivez pour partager une localisation approximative.
