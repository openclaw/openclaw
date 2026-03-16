---
summary: "Comportement de streaming + découpage (réponses par blocs, streaming de brouillon, limites)"
read_when:
  - Expliquer comment fonctionne le streaming ou le découpage sur les canaux
  - Changer le streaming par blocs ou le comportement de découpage de canal
  - Déboguer des réponses par blocs dupliquées/précoces ou du streaming de brouillon
title: "Streaming et découpage"
---

# Streaming + découpage

OpenClaw a deux couches de "streaming" séparées :

- **Streaming par blocs (canaux) :** émet des **blocs** complétés pendant que l'assistant écrit. Ce sont des messages de canal normaux (pas des deltas de jetons).
- **Streaming type jeton (Telegram uniquement) :** met à jour une **bulle de brouillon** avec du texte partiel pendant la génération ; le message final est envoyé à la fin.

Il n'y a **pas de vrai streaming de jetons** vers les messages de canal externes aujourd'hui. Le streaming de brouillon Telegram est la seule surface de flux partiel.

## Streaming par blocs (messages de canal)

Le streaming par blocs envoie la sortie assistant en morceaux grossiers à mesure qu'elle devient disponible.

```
Sortie du modèle
  └─ text_delta/événements
       ├─ (blockStreamingBreak=text_end)
       │    └─ le découpeur émet des blocs à mesure que le tampon grandit
       └─ (blockStreamingBreak=message_end)
            └─ le découpeur vide à message_end
                   └─ envoi de canal (réponses par blocs)
```

Légende :

- `text_delta/événements` : événements de flux de modèle (peuvent être clairsemés pour les modèles non-streaming).
- `découpeur` : `EmbeddedBlockChunker` appliquant les limites min/max + préférence de coupure.
- `envoi de canal` : messages sortants réels (réponses par blocs).

**Contrôles :**

- `agents.defaults.blockStreamingDefault` : `"on"`/`"off"` (par défaut off).
- Remplacements de canal : `*.blockStreaming` (et variantes par compte) pour forcer `"on"`/`"off"` par canal.
- `agents.defaults.blockStreamingBreak` : `"text_end"` ou `"message_end"`.
- `agents.defaults.blockStreamingChunk` : `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce` : `{ minChars?, maxChars?, idleMs? }` (fusionner les blocs streamés avant envoi).
- Plafond dur de canal : `*.textChunkLimit` (ex., `channels.whatsapp.textChunkLimit`).
- Mode de découpage de canal : `*.chunkMode` (par défaut `length`, `newline` divise sur les lignes vides (limites de paragraphe) avant le découpage de longueur).
- Plafond doux Discord : `channels.discord.maxLinesPerMessage` (par défaut 17) divise les réponses hautes pour éviter le découpage UI.

**Sémantique de limite :**

- `text_end` : streame les blocs dès que le découpeur émet ; vide sur chaque `text_end`.
- `message_end` : attend jusqu'à ce que le message assistant finisse, puis vide la sortie tamponnée.

`message_end` utilise toujours le découpeur si le texte tamponné dépasse `maxChars`, donc il peut émettre plusieurs morceaux à la fin.

## Algorithme de découpage (limites basse/haute)

Le découpage par blocs est implémenté par `EmbeddedBlockChunker` :

- **Limite basse :** n'émet pas jusqu'à ce que tampon >= `minChars` (sauf si forcé).
- **Limite haute :** préfère les divisions avant `maxChars` ; si forcé, divise à `maxChars`.
- **Préférence de coupure :** `paragraph` → `newline` → `sentence` → `whitespace` → coupure dure.
- **Clôtures de code :** ne divise jamais à l'intérieur des clôtures ; quand forcé à `maxChars`, ferme + rouvre la clôture pour garder le Markdown valide.

`maxChars` est plafonné au `textChunkLimit` de canal, donc vous ne pouvez pas dépasser les plafonds par canal.

## Fusion (fusionner les blocs streamés)

Quand le streaming par blocs est activé, OpenClaw peut **fusionner les morceaux de blocs consécutifs**
avant de les envoyer. Cela réduit le "spam à ligne unique" tout en fournissant toujours
une sortie progressive.

- La fusion attend des **intervalles d'inactivité** (`idleMs`) avant de vider.
- Les tampons sont plafonnés par `maxChars` et videront s'ils le dépassent.
- `minChars` empêche les petits fragments d'envoyer jusqu'à ce que suffisamment de texte s'accumule
  (le vidage final envoie toujours le texte restant).
- Le joigneur est dérivé de `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → espace).
- Les remplacements de canal sont disponibles via `*.blockStreamingCoalesce` (y compris configs par compte).
- Le `minChars` de fusion par défaut est augmenté à 1500 pour Signal/Slack/Discord sauf si remplacé.

## Rythme semblable à humain entre blocs

Quand le streaming par blocs est activé, vous pouvez ajouter une **pause aléatoire** entre
les réponses par blocs (après le premier bloc). Cela rend les réponses multi-bulles plus
naturelles.

- Config : `agents.defaults.humanDelay` (remplacer par agent via `agents.list[].humanDelay`).
- Modes : `off` (par défaut), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- S'applique uniquement aux **réponses par blocs**, pas aux réponses finales ou résumés d'outils.

## "Streamer les morceaux ou tout"

Cela mappe vers :

- **Streamer les morceaux :** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (émet en cours). Les canaux non-Telegram ont aussi besoin de `*.blockStreaming: true`.
- **Streamer tout à la fin :** `blockStreamingBreak: "message_end"` (vide une fois, possiblement plusieurs morceaux si très long).
- **Pas de streaming par blocs :** `blockStreamingDefault: "off"` (uniquement réponse finale).

**Note de canal :** Pour les canaux non-Telegram, le streaming par blocs est **off sauf si**
`*.blockStreaming` est explicitement défini à `true`. Telegram peut streamer des brouillons
(`channels.telegram.streamMode`) sans réponses par blocs.

Rappel d'emplacement de config : les valeurs par défaut `blockStreaming*` vivent sous
`agents.defaults`, pas la config racine.

## Streaming de brouillon Telegram (type jeton)

Telegram est le seul canal avec streaming de brouillon :

- Utilise l'API Bot `sendMessageDraft` dans **les chats privés avec sujets**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial` : les mises à jour de brouillon avec le dernier texte de flux.
  - `block` : les mises à jour de brouillon en blocs découpés (mêmes règles de découpeur).
  - `off` : pas de streaming de brouillon.
- Config de morceau de brouillon (uniquement pour `streamMode: "block"`) : `channels.telegram.draftChunk` (par défaut : `minChars: 200`, `maxChars: 800`).
- Le streaming de brouillon est séparé du streaming par blocs ; les réponses par blocs sont off par défaut et uniquement activées par `*.blockStreaming: true` sur les canaux non-Telegram.
- La réponse finale est toujours un message normal.
- `/reasoning stream` écrit le raisonnement dans la bulle de brouillon (Telegram uniquement).

Quand le streaming de brouillon est actif, OpenClaw désactive le streaming par blocs pour cette réponse pour éviter le double-streaming.

```
Telegram (privé + sujets)
  └─ sendMessageDraft (bulle de brouillon)
       ├─ streamMode=partial → met à jour le dernier texte
       └─ streamMode=block   → le découpeur met à jour le brouillon
  └─ réponse finale → message normal
```

Légende :

- `sendMessageDraft` : bulle de brouillon Telegram (pas un vrai message).
- `réponse finale` : envoi de message Telegram normal.
