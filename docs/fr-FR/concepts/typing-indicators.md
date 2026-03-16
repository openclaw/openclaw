---
summary: "Quand OpenClaw montre des indicateurs de frappe et comment les ajuster"
read_when:
  - Changer le comportement ou les valeurs par défaut des indicateurs de frappe
title: "Indicateurs de frappe"
---

# Indicateurs de frappe

Les indicateurs de frappe sont envoyés au canal de chat pendant qu'une exécution est active. Utilisez
`agents.defaults.typingMode` pour contrôler **quand** la frappe démarre et `typingIntervalSeconds`
pour contrôler **à quelle fréquence** elle se rafraîchit.

## Valeurs par défaut

Quand `agents.defaults.typingMode` est **non défini**, OpenClaw garde le comportement hérité :

- **Chats directs** : la frappe démarre immédiatement une fois que la boucle de modèle commence.
- **Chats de groupe avec mention** : la frappe démarre immédiatement.
- **Chats de groupe sans mention** : la frappe démarre uniquement quand le texte de message commence à streamer.
- **Exécutions de heartbeat** : la frappe est désactivée.

## Modes

Définissez `agents.defaults.typingMode` à l'un des :

- `never` — pas d'indicateur de frappe, jamais.
- `instant` — démarre la frappe **dès que la boucle de modèle commence**, même si l'exécution
  retourne plus tard uniquement le jeton de réponse silencieux.
- `thinking` — démarre la frappe au **premier delta de raisonnement** (nécessite
  `reasoningLevel: "stream"` pour l'exécution).
- `message` — démarre la frappe au **premier delta de texte non silencieux** (ignore
  le jeton silencieux `NO_REPLY`).

Ordre de "à quel point ça se déclenche tôt" :
`never` → `message` → `thinking` → `instant`

## Configuration

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Vous pouvez remplacer le mode ou la cadence par session :

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notes

- Le mode `message` ne montrera pas de frappe pour les réponses silencieuses uniquement (ex. le jeton `NO_REPLY`
  utilisé pour supprimer la sortie).
- `thinking` ne se déclenche que si l'exécution streame le raisonnement (`reasoningLevel: "stream"`).
  Si le modèle n'émet pas de deltas de raisonnement, la frappe ne démarrera pas.
- Les heartbeats ne montrent jamais de frappe, quel que soit le mode.
- `typingIntervalSeconds` contrôle la **cadence de rafraîchissement**, pas l'heure de démarrage.
  Le défaut est 6 secondes.
