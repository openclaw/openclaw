---
summary: "Comportement de streaming et de découpage (réponses par blocs, streaming de brouillon, limites)"
read_when:
  - Expliquer comment le streaming ou le découpage fonctionne sur les canaux
  - Modifier le streaming par blocs ou le comportement de découpage par canal
  - Déboguer les réponses par blocs dupliquées/prématurées ou le streaming de brouillon
title: "Streaming et découpage"
---

# Streaming + découpage

OpenClaw dispose de deux couches de « streaming » distinctes :

- **Streaming par blocs (canaux) :** émet des **blocs** terminés au fur et à mesure que l’assistant écrit. Ce sont des messages de canal normaux (pas des deltas de tokens).
- **Streaming pseudo‑token (Telegram uniquement) :** met à jour une **bulle de brouillon** avec du texte partiel pendant la génération ; le message final est envoyé à la fin.

Il n’existe **pas de véritable streaming de tokens** vers des messages de canal externes aujourd’hui. Le streaming de brouillon Telegram est la seule surface de streaming partiel.

## Streaming par blocs (messages de canal)

Le streaming par blocs envoie la sortie de l’assistant en morceaux grossiers dès qu’ils sont disponibles.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Légende :

- `text_delta/events` : événements de flux du modèle (peuvent être rares pour les modèles non streaming).
- `chunker` : `EmbeddedBlockChunker` appliquant des bornes min/max + préférence de coupure.
- `channel send` : messages sortants réels (réponses par blocs).

**Contrôles :**

- `agents.defaults.blockStreamingDefault` : `"on"`/`"off"` (désactivé par défaut).
- Surcharges par canal : `*.blockStreaming` (et variantes par compte) pour forcer `"on"`/`"off"` par canal.
- `agents.defaults.blockStreamingBreak` : `"text_end"` ou `"message_end"`.
- `agents.defaults.blockStreamingChunk` : `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce` : `{ minChars?, maxChars?, idleMs? }` (fusionner les blocs streamés avant l’envoi).
- Plafond strict par canal : `*.textChunkLimit` (p. ex., `channels.whatsapp.textChunkLimit`).
- Mode de découpage par canal : `*.chunkMode` (`length` par défaut, `newline` découpe sur les lignes vides (frontières de paragraphe) avant le découpage par longueur).
- Plafond souple Discord : `channels.discord.maxLinesPerMessage` (17 par défaut) découpe les réponses très longues pour éviter le rognage de l’UI.

**Sémantique des frontières :**

- `text_end` : streamer les blocs dès que le découpeur émet ; vidanger à chaque `text_end`.
- `message_end` : attendre la fin du message de l’assistant, puis vidanger la sortie mise en tampon.

`message_end` utilise toujours le découpeur si le texte tamponné dépasse `maxChars`, ce qui peut émettre plusieurs morceaux à la fin.

## Algorithme de découpage (bornes basse/haute)

Le découpage par blocs est implémenté par `EmbeddedBlockChunker` :

- **Borne basse :** ne pas émettre tant que le tampon < `minChars` (sauf forçage).
- **Borne haute :** préférer des coupures avant `maxChars` ; si forcé, couper à `maxChars`.
- **Préférence de coupure :** `paragraph` → `newline` → `sentence` → `whitespace` → coupure dure.
- **Blocs de code :** ne jamais couper à l’intérieur ; si forcé à `maxChars`, fermer puis rouvrir le bloc pour conserver un Markdown valide.

`maxChars` est borné par le `textChunkLimit` du canal, vous ne pouvez donc pas dépasser les plafonds par canal.

## Coalescence (fusion des blocs streamés)

Lorsque le streaming par blocs est activé, OpenClaw peut **fusionner des morceaux de blocs consécutifs**
avant leur envoi. Cela réduit le « spam ligne par ligne » tout en fournissant
une sortie progressive.

- La coalescence attend des **intervalles d’inactivité** (`idleMs`) avant de vidanger.
- Les tampons sont plafonnés par `maxChars` et seront vidangés s’ils le dépassent.
- `minChars` empêche l’envoi de fragments minuscules tant que suffisamment de texte ne s’accumule pas
  (la vidange finale envoie toujours le texte restant).
- Le séparateur est dérivé de `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → espace).
- Des surcharges par canal sont disponibles via `*.blockStreamingCoalesce` (y compris des configurations par compte).
- La valeur par défaut de coalescence `minChars` est portée à 1500 pour Signal/Slack/Discord sauf surcharge.

## Rythme « humain » entre les blocs

Lorsque le streaming par blocs est activé, vous pouvez ajouter une **pause aléatoire**
entre les réponses par blocs (après le premier bloc). Cela rend les réponses multi‑bulles
plus naturelles.

- Configuration : `agents.defaults.humanDelay` (surcharge par agent via `agents.list[].humanDelay`).
- Modes : `off` (par défaut), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- S’applique uniquement aux **réponses par blocs**, pas aux réponses finales ni aux résumés d’outils.

## « Streamer les morceaux ou tout à la fin »

Ceci correspond à :

- **Streamer les morceaux :** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (émettre au fil de l’eau). Les canaux non Telegram nécessitent aussi `*.blockStreaming: true`.
- **Tout streamer à la fin :** `blockStreamingBreak: "message_end"` (vidange unique, éventuellement en plusieurs morceaux si très long).
- **Pas de streaming par blocs :** `blockStreamingDefault: "off"` (réponse finale uniquement).

**Note par canal :** pour les canaux non Telegram, le streaming par blocs est **désactivé sauf si**
`*.blockStreaming` est explicitement défini sur `true`. Telegram peut streamer des brouillons
(`channels.telegram.streamMode`) sans réponses par blocs.

Rappel d’emplacement de configuration : les valeurs par défaut `blockStreaming*` se trouvent sous
`agents.defaults`, et non à la racine de la configuration.

## Streaming de brouillon Telegram (pseudo‑token)

Telegram est le seul canal avec streaming de brouillon :

- Utilise l’API Bot `sendMessageDraft` dans les **chats privés avec sujets**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial` : mises à jour du brouillon avec le dernier texte streamé.
  - `block` : mises à jour du brouillon par blocs découpés (mêmes règles de découpage).
  - `off` : pas de streaming de brouillon.
- Configuration du découpage du brouillon (uniquement pour `streamMode: "block"`) : `channels.telegram.draftChunk` (valeurs par défaut : `minChars: 200`, `maxChars: 800`).
- Le streaming de brouillon est distinct du streaming par blocs ; les réponses par blocs sont désactivées par défaut et ne sont activées par `*.blockStreaming: true` que sur les canaux non Telegram.
- La réponse finale reste un message normal.
- `/reasoning stream` écrit le raisonnement dans la bulle de brouillon (Telegram uniquement).

Lorsque le streaming de brouillon est actif, OpenClaw désactive le streaming par blocs pour cette réponse afin d’éviter un double streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Légende :

- `sendMessageDraft` : bulle de brouillon Telegram (pas un vrai message).
- `final reply` : envoi de message Telegram normal.
