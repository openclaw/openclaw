---
summary: "Streaming- och chunkingbeteende (blockrepliker, utkaststreaming, gränser)"
read_when:
  - Förklara hur streaming eller chunking fungerar på kanaler
  - Ändra blockstreaming eller kanalens chunkingbeteende
  - Felsöka dubbla/tidiga blockrepliker eller utkaststreaming
title: "Streaming och Chunking"
---

# Streaming + chunking

OpenClaw har två separata ”streaming”-lager:

- **Blockera strömning (kanaler):** avger **block** som assistenten skriver. Dessa är normala kanalmeddelanden (inte token deltas).
- **Token‑lik streaming (endast Telegram):** uppdaterar en **utkastbubbla** med partiell text under generering; slutligt meddelande skickas i slutet.

Det finns **ingen riktig token streaming** till externa kanalmeddelanden idag. Telegram utkast streaming är den enda delströmsytan.

## Blockstreaming (kanalmeddelanden)

Blockstreaming skickar assistentens utdata i grova chunkar när de blir tillgängliga.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: modellens streamevent (kan vara glesa för icke‑streamande modeller).
- `chunker`: `EmbeddedBlockChunker` som tillämpar min-/maxgränser + brytpreferens.
- `channel send`: faktiska utgående meddelanden (blockrepliker).

**Kontroller:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (av som standard).
- Kanalöverskrivningar: `*.blockStreaming` (och varianter per konto) för att tvinga `"on"`/`"off"` per kanal.
- `agents.defaults.blockStreamingBreak`: `"text_end"` eller `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (slå samman strömmade block innan sändning).
- Kanal hård cap: `*.textChunkLimit` (t.ex., `channels.whatsapp.textChunkLimit`).
- Kanalens chunk‑läge: `*.chunkMode` (`length` standard, `newline` delar vid tomma rader (styckegränser) före längdchunking).
- Discords mjuka tak: `channels.discord.maxLinesPerMessage` (standard 17) delar höga svar för att undvika UI‑klippning.

**Gränssemantik:**

- `text_end`: streama block så snart chunkern emitterar; flush vid varje `text_end`.
- `message_end`: vänta tills assistentmeddelandet är klart och flush sedan buffrad utdata.

`message_end` använder fortfarande chunkern om den buffrade texten överstiger `maxChars`, så den kan skicka flera chunkar i slutet.

## Chunkingalgoritm (låg/hög gräns)

Block‑chunking implementeras av `EmbeddedBlockChunker`:

- **Låg gräns:** skicka inte förrän bufferten ≥ `minChars` (om inte tvingat).
- **Hög gräns:** föredra delningar före `maxChars`; om tvingat, dela vid `maxChars`.
- **Brytpreferens:** `paragraph` → `newline` → `sentence` → `whitespace` → hård brytning.
- **Kodstaket:** dela aldrig inuti staket; när tvingat vid `maxChars`, stäng + öppna staketet igen för att hålla Markdown giltigt.

`maxChars` klamras till kanalens `textChunkLimit`, så du kan inte överskrida per‑kanal‑tak.

## Sammanfogning (slå ihop streamade block)

När blockstreaming är aktiverat kan OpenClaw **sammanfoga blockchunks**
innan de skickas ut. Detta minskar “en-line skräppost” samtidigt som
progressiv utgång.

- Sammanfogning väntar på **inaktivitetsglapp** (`idleMs`) innan flush.
- Buffertar begränsas av `maxChars` och flushas om de överskrids.
- `minChars` förhindrar att pyttesmå fragment skickas innan tillräckligt med text ackumuleras
  (slutlig flush skickar alltid återstående text).
- Sammanfogningsseparator härleds från `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → mellanslag).
- Kanalöverskrivningar finns via `*.blockStreamingCoalesce` (inklusive konfig per konto).
- Standardvärdet för sammanfogning `minChars` höjs till 1500 för Signal/Slack/Discord om det inte åsidosätts.

## Mänsklig takt mellan block

När blockströmning är aktiverad, kan du lägga till en **slumpmässig paus** mellan
blocksvar (efter det första blocket). Detta gör att multibubbla svar känns
mer naturliga.

- Konfig: `agents.defaults.humanDelay` (åsidosätt per agent via `agents.list[].humanDelay`).
- Lägen: `off` (standard), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Gäller endast **blockrepliker**, inte slutliga svar eller verktygssammanfattningar.

## ”Streama chunkar eller allt”

Detta motsvarar:

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (avge när du går). Icke-Telegram kanaler behöver också `*.blockStreaming: true`.
- **Streama allt i slutet:** `blockStreamingBreak: "message_end"` (flush en gång, eventuellt flera chunkar om mycket långt).
- **Ingen blockstreaming:** `blockStreamingDefault: "off"` (endast slutligt svar).

**Kanalnotera:** För icke-Telegram kanaler är blockströmning **av olösa**
`*.blockStreaming` är explicit satt till `true`. Telegram kan strömma utkast
(`channels.telegram.streamMode`) utan blocksvar.

Påminnelse om konfigplats: standardvärdena för `blockStreaming*` finns under
`agents.defaults`, inte i rotkonfigen.

## Telegram utkaststreaming (token‑lik)

Telegram är den enda kanalen med utkaststreaming:

- Använder Bot API `sendMessageDraft` i **privata chattar med ämnen**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: utkastuppdateringar med senaste streamtexten.
  - `block`: utkastuppdateringar i chunkade block (samma chunkerregler).
  - `off`: ingen utkaststreaming.
- Konfig för utkastchunkar (endast för `streamMode: "block"`): `channels.telegram.draftChunk` (standard: `minChars: 200`, `maxChars: 800`).
- Utkaststreaming är separat från blockstreaming; blockrepliker är av som standard och aktiveras endast av `*.blockStreaming: true` på icke‑Telegram‑kanaler.
- Slutligt svar är fortfarande ett normalt meddelande.
- `/reasoning stream` skriver resonemang i utkastbubblan (endast Telegram).

När utkaststreaming är aktiv inaktiverar OpenClaw blockstreaming för det svaret för att undvika dubbel streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram‑utkastbubbla (inte ett riktigt meddelande).
- `final reply`: normalt Telegram‑meddelande.
