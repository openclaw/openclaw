---
summary: "Quand OpenClaw affiche des indicateurs de saisie et comment les ajuster"
read_when:
  - Modification du comportement ou des valeurs par defaut des indicateurs de saisie
title: "Indicateurs de saisie"
---

# Indicateurs de saisie

Les indicateurs de saisie sont envoyes au canal de chat pendant qu’une execution est active. Utilisez
`agents.defaults.typingMode` pour controler **quand** la saisie commence et `typingIntervalSeconds`
pour controler **a quelle frequence** elle est rafraichie.

## Valeurs par défaut

Lorsque `agents.defaults.typingMode` n’est **pas defini**, OpenClaw conserve le comportement historique :

- **Conversations directes** : la saisie commence immediatement des que la boucle du modele debute.
- **Conversations de groupe avec mention** : la saisie commence immediatement.
- **Conversations de groupe sans mention** : la saisie commence uniquement lorsque le texte du message commence a etre diffuse.
- **Executions de heartbeat** : la saisie est desactivee.

## Modes

Definissez `agents.defaults.typingMode` sur l’une des valeurs suivantes :

- `never` — aucun indicateur de saisie, jamais.
- `instant` — commencer la saisie **des que la boucle du modele debute**, meme si l’execution
  retourne ensuite uniquement le jeton de reponse silencieuse.
- `thinking` — commencer la saisie a la **premiere variation de raisonnement** (necessite
  `reasoningLevel: "stream"` pour l’execution).
- `message` — commencer la saisie a la **premiere variation de texte non silencieuse** (ignore
  le jeton silencieux `NO_REPLY`).

Ordre selon « la precocite du declenchement » :
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

Vous pouvez remplacer le mode ou la cadence par session :

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notes

- Le mode `message` n’affiche pas la saisie pour les reponses uniquement silencieuses (par ex. le jeton `NO_REPLY`
  utilise pour supprimer la sortie).
- `thinking` ne se declenche que si l’execution diffuse le raisonnement (`reasoningLevel: "stream"`).
  Si le modele n’emet pas de variations de raisonnement, la saisie ne demarre pas.
- Les heartbeats n’affichent jamais la saisie, quel que soit le mode.
- `typingIntervalSeconds` controle la **cadence de rafraichissement**, pas l’heure de demarrage.
  La valeur par defaut est de 6 secondes.
