---
summary: "Streaming- und Chunking-Verhalten (Blockantworten, Entwurfs-Streaming, Limits)"
read_when:
  - Erklärung, wie Streaming oder Chunking auf Kanälen funktioniert
  - Ändern des Block-Streamings oder des Kanal-Chunking-Verhaltens
  - Debugging von doppelten/frühen Blockantworten oder Entwurfs-Streaming
title: "Streaming und Chunking"
---

# Streaming + Chunking

OpenClaw hat zwei separate „Streaming“-Ebenen:

- **Block-Streaming (Kanäle):** gibt abgeschlossene **Blöcke** aus, während der Assistent schreibt. Dies sind normale Kanalnachrichten (keine Token-Deltas).
- **Token-ähnliches Streaming (nur Telegram):** aktualisiert während der Generierung eine **Entwurfsblase** mit partiellem Text; die finale Nachricht wird am Ende gesendet.

Es gibt derzeit **kein echtes Token-Streaming** zu externen Kanalnachrichten. Telegram-Entwurfs-Streaming ist die einzige Oberfläche für Teil-Streaming.

## Block-Streaming (Kanalnachrichten)

Block-Streaming sendet Assistenten-Ausgaben in groben Chunks, sobald sie verfügbar sind.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legende:

- `text_delta/events`: Modell-Stream-Ereignisse (können bei nicht-streamenden Modellen spärlich sein).
- `chunker`: `EmbeddedBlockChunker` unter Anwendung von Min-/Max-Grenzen + Trennpräferenz.
- `channel send`: tatsächliche ausgehende Nachrichten (Blockantworten).

**Steuerungen:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (standardmäßig aus).
- Kanalüberschreibungen: `*.blockStreaming` (und Varianten pro Konto), um `"on"`/`"off"` pro Kanal zu erzwingen.
- `agents.defaults.blockStreamingBreak`: `"text_end"` oder `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (gestreamte Blöcke vor dem Senden zusammenführen).
- Harte Kanalgrenze: `*.textChunkLimit` (z. B. `channels.whatsapp.textChunkLimit`).
- Kanal-Chunk-Modus: `*.chunkMode` (`length` Standard, `newline` trennt an Leerzeilen (Absatzgrenzen) vor dem Längen-Chunking).
- Discord-Soft-Cap: `channels.discord.maxLinesPerMessage` (Standard 17) teilt hohe Antworten, um UI-Clipping zu vermeiden.

**Grenzsemantik:**

- `text_end`: streamt Blöcke, sobald der Chunker ausgibt; Flush bei jedem `text_end`.
- `message_end`: wartet, bis die Assistenten-Nachricht abgeschlossen ist, und flusht dann den gepufferten Output.

`message_end` verwendet weiterhin den Chunker, wenn der gepufferte Text `maxChars` überschreitet, sodass am Ende mehrere Chunks ausgegeben werden können.

## Chunking-Algorithmus (untere/obere Grenzen)

Block-Chunking wird implementiert durch `EmbeddedBlockChunker`:

- **Untere Grenze:** nicht ausgeben, bis der Puffer >= `minChars` ist (außer erzwungen).
- **Obere Grenze:** bevorzugt Trennungen vor `maxChars`; wenn erzwungen, Trennung bei `maxChars`.
- **Trennpräferenz:** `paragraph` → `newline` → `sentence` → `whitespace` → harte Trennung.
- **Code-Fences:** niemals innerhalb von Fences trennen; wenn bei `maxChars` erzwungen, Fence schließen + erneut öffnen, um gültiges Markdown zu behalten.

`maxChars` wird auf die kanalweite `textChunkLimit` begrenzt, sodass kanalabhängige Limits nicht überschritten werden können.

## Zusammenführen (gestreamte Blöcke mergen)

Wenn Block-Streaming aktiviert ist, kann OpenClaw **aufeinanderfolgende Block-Chunks zusammenführen**, bevor sie gesendet werden. Das reduziert „Einzeilen-Spam“, während weiterhin progressiver Output bereitgestellt wird.

- Das Zusammenführen wartet auf **Leerlauf-Lücken** (`idleMs`), bevor geflusht wird.
- Puffer sind durch `maxChars` begrenzt und werden geflusht, wenn sie diese überschreiten.
- `minChars` verhindert das Senden winziger Fragmente, bis sich genügend Text angesammelt hat
  (der finale Flush sendet immer den verbleibenden Text).
- Der Joiner wird aus `blockStreamingChunk.breakPreference` abgeleitet
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → Leerzeichen).
- Kanalüberschreibungen sind über `*.blockStreamingCoalesce` verfügbar (einschließlich Konfigurationen pro Konto).
- Der Standardwert für das Zusammenführen `minChars` wird für Signal/Slack/Discord auf 1500 erhöht, sofern nicht überschrieben.

## Menschlich wirkendes Tempo zwischen Blöcken

Wenn Block-Streaming aktiviert ist, können Sie zwischen Blockantworten (nach dem ersten Block) eine **zufällige Pause** hinzufügen. Dadurch wirken Antworten mit mehreren Blasen natürlicher.

- Konfiguration: `agents.defaults.humanDelay` (Überschreibung pro Agent über `agents.list[].humanDelay`).
- Modi: `off` (Standard), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Gilt nur für **Blockantworten**, nicht für finale Antworten oder Werkzeug-Zusammenfassungen.

## „Chunks streamen oder alles auf einmal“

Diese Karten zu:

- **Chunks streamen:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (Ausgabe während der Generierung). Nicht-Telegram-Kanäle benötigen zusätzlich `*.blockStreaming: true`.
- **Alles am Ende streamen:** `blockStreamingBreak: "message_end"` (einmal flushen, ggf.
- **Kein Block-Streaming:** `blockStreamingDefault: "off"` (nur finale Antwort).

**Kanalhinweis:** Für Nicht-Telegram-Kanäle ist Block-Streaming **aus, sofern**
`*.blockStreaming` nicht explizit auf `true` gesetzt ist. Telegram kann Entwürfe streamen
(`channels.telegram.streamMode`), ohne Blockantworten zu senden.

Hinweis zum Konfigurationsort: Die Standardwerte von `blockStreaming*` befinden sich unter
`agents.defaults`, nicht in der Root-Konfiguration.

## Telegram-Entwurfs-Streaming (token-ähnlich)

Telegram ist der einzige Kanal mit Entwurfs-Streaming:

- Verwendet die Bot-API `sendMessageDraft` in **Privatchats mit Topics**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: Entwurfs-Updates mit dem neuesten Stream-Text.
  - `block`: Entwurfs-Updates in gechunkten Blöcken (gleiche Chunker-Regeln).
  - `off`: kein Entwurfs-Streaming.
- Entwurfs-Chunk-Konfiguration (nur für `streamMode: "block"`): `channels.telegram.draftChunk` (Standardwerte: `minChars: 200`, `maxChars: 800`).
- Entwurfs-Streaming ist vom Block-Streaming getrennt; Blockantworten sind standardmäßig aus und werden auf Nicht-Telegram-Kanälen nur durch `*.blockStreaming: true` aktiviert.
- Die finale Antwort ist weiterhin eine normale Nachricht.
- `/reasoning stream` schreibt die Begründung in die Entwurfsblase (nur Telegram).

Wenn Entwurfs-Streaming aktiv ist, deaktiviert OpenClaw das Block-Streaming für diese Antwort, um doppeltes Streaming zu vermeiden.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legende:

- `sendMessageDraft`: Telegram-Entwurfsblase (keine echte Nachricht).
- `final reply`: normales Senden einer Telegram-Nachricht.
