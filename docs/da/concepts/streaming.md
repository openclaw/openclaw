---
summary: "Streaming- og chunking-adfærd (blokbesvarelser, udkast-streaming, grænser)"
read_when:
  - Forklaring af, hvordan streaming eller chunking fungerer på kanaler
  - Ændring af blokstreaming eller kanal-chunking-adfærd
  - Fejlfinding af duplikerede/tidlige blokbesvarelser eller udkast-streaming
title: "Streaming og Chunking"
---

# Streaming + chunking

OpenClaw har to separate “streaming”-lag:

- **Blokér streaming (kanal):** Udleder **blokke** som assistenten skriver. Disse er normale kanalmeddelelser (ikke token deltas).
- **Token-agtig streaming (kun Telegram):** opdaterer en **udkast-boble** med delvis tekst under generering; den endelige besked sendes til sidst.

Der er **ingen ægte token streaming** til eksterne kanalbeskeder i dag. Telegram udkast streaming er den eneste del-stream overflade.

## Blokstreaming (kanalbeskeder)

Blokstreaming sender assistentens output i grove bidder, efterhånden som det bliver tilgængeligt.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Forklaring:

- `text_delta/events`: model-stream-events (kan være sparsomme for ikke-streamende modeller).
- `chunker`: `EmbeddedBlockChunker` anvender min./maks.-grænser + brud-præference.
- `channel send`: faktiske udgående beskeder (blokbesvarelser).

**Kontroller:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (standard fra).
- Kanal-overskrivninger: `*.blockStreaming` (og per-konto-varianter) for at tvinge `"on"`/`"off"` pr. kanal.
- `agents.defaults.blockStreamingBreak`: `"text_end"` eller `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (flette streamede blokke før afsendelse).
- Kanal-hård grænse: `*.textChunkLimit` (fx `channels.whatsapp.textChunkLimit`).
- Kanal-chunk-tilstand: `*.chunkMode` (`length` standard, `newline` deler ved tomme linjer (afsnitsgrænser) før længde-chunking).
- Discord blød grænse: `channels.discord.maxLinesPerMessage` (standard 17) deler høje svar for at undgå UI-klipning.

**Grænsesemantik:**

- `text_end`: stream blokke, så snart chunkeren udsender; flush ved hver `text_end`.
- `message_end`: vent, indtil assistentens besked er færdig, og flush derefter bufferet output.

`message_end` bruger stadig chunkeren, hvis den bufferede tekst overstiger `maxChars`, så den kan udsende flere chunks til sidst.

## Chunking-algoritme (lave/høje grænser)

Blok-chunking er implementeret af `EmbeddedBlockChunker`:

- **Lav grænse:** udsend ikke, før buffer >= `minChars` (medmindre tvunget).
- **Høj grænse:** foretræk opdelinger før `maxChars`; hvis tvunget, del ved `maxChars`.
- **Brud-præference:** `paragraph` → `newline` → `sentence` → `whitespace` → hårdt brud.
- **Kodehegn:** del aldrig inde i hegn; når tvunget ved `maxChars`, luk + genåbn hegnet for at holde Markdown gyldigt.

`maxChars` er klemt til kanalens `textChunkLimit`, så du kan ikke overskride kanal-specifikke lofter.

## Sammenfletning (flet streamede blokke)

Når blokstreaming er aktiveret, kan OpenClaw **flette sammenhængende blokchunks**
før du sender dem ud. Dette reducerer “single-line spam”, mens du stadig leverer
progressiv output.

- Sammenfletning venter på **inaktive mellemrum** (`idleMs`) før flush.
- Buffere er begrænset af `maxChars` og flushes, hvis de overskrides.
- `minChars` forhindrer, at meget små fragmenter sendes, før nok tekst er akkumuleret
  (den endelige flush sender altid resterende tekst).
- Sammenføjer er afledt af `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → mellemrum).
- Kanal-overskrivninger er tilgængelige via `*.blockStreamingCoalesce` (inkl. per-konto-konfigurationer).
- Standard sammenfletnings-`minChars` hæves til 1500 for Signal/Slack/Discord, medmindre det overskrives.

## Menneskelignende tempo mellem blokke

Når blok streaming er aktiveret, kan du tilføje en **randomiseret pause** mellem
blok svar (efter den første blok). Dette gør multi-boble respons føles
mere naturligt.

- Konfiguration: `agents.defaults.humanDelay` (overskriv pr. agent via `agents.list[].humanDelay`).
- Tilstande: `off` (standard), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Gælder kun **blokbesvarelser**, ikke endelige svar eller værktøjsresuméer.

## “Stream chunks eller det hele”

Dette svarer til:

- **Stream chunks:** `blockStreamingStandard: "on"` + `blockStreamingBreak: "text_end"` (udsender som du går). Ikke-Telegram kanaler har også brug for `*.blockStreaming: true`.
- **Stream det hele til sidst:** `blockStreamingBreak: "message_end"` (flush én gang, muligvis i flere chunks, hvis meget langt).
- **Ingen blokstreaming:** `blockStreamingDefault: "off"` (kun endeligt svar).

**Kanal note:** For ikke-Telegram kanaler, blok streaming er **off unless**
`*.blockStreaming` er udtrykkeligt indstillet til `true`. Telegram kan streame kladder
(`channels.telegram.streamMode`) uden blok svar.

Påmindelse om konfigurationsplacering: `blockStreaming*`-standarder ligger under
`agents.defaults`, ikke i rod-konfigurationen.

## Telegram-udkast-streaming (token-agtig)

Telegram er den eneste kanal med udkast-streaming:

- Bruger Bot API `sendMessageDraft` i **private chats med emner**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: udkast-opdateringer med den nyeste stream-tekst.
  - `block`: udkast-opdateringer i chunkede blokke (samme chunker-regler).
  - `off`: ingen udkast-streaming.
- Udkast-chunk-konfiguration (kun for `streamMode: "block"`): `channels.telegram.draftChunk` (standarder: `minChars: 200`, `maxChars: 800`).
- Udkast-streaming er adskilt fra blokstreaming; blokbesvarelser er som standard slået fra og aktiveres kun via `*.blockStreaming: true` på ikke-Telegram-kanaler.
- Det endelige svar er stadig en normal besked.
- `/reasoning stream` skriver ræsonnement ind i udkast-boblen (kun Telegram).

Når udkast-streaming er aktiv, deaktiverer OpenClaw blokstreaming for det svar for at undgå dobbelt-streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Forklaring:

- `sendMessageDraft`: Telegram-udkast-boble (ikke en rigtig besked).
- `final reply`: normal afsendelse af Telegram-besked.
