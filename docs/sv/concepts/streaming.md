---
summary: "Streaming- och chunkingbeteende (blockrepliker, utkaststreaming, gränser)"
read_when:
  - Förklara hur streaming eller chunking fungerar på kanaler
  - Ändra blockstreaming eller kanalens chunkingbeteende
  - Felsöka dubbla/tidiga blockrepliker eller utkaststreaming
title: "Streaming och Chunking"
x-i18n:
  source_path: concepts/streaming.md
  source_hash: f014eb1898c4351b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:13Z
---

# Streaming + chunking

OpenClaw har två separata ”streaming”-lager:

- **Blockstreaming (kanaler):** skickar färdiga **block** när assistenten skriver. Dessa är vanliga kanalmeddelanden (inte tokendeltor).
- **Token‑lik streaming (endast Telegram):** uppdaterar en **utkastbubbla** med partiell text under generering; slutligt meddelande skickas i slutet.

Det finns **ingen riktig tokenstreaming** till externa kanalmeddelanden i dag. Telegrams utkaststreaming är den enda ytan för partiell streaming.

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
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (slå ihop streamade block före sändning).
- Kanalens hårda tak: `*.textChunkLimit` (t.ex. `channels.whatsapp.textChunkLimit`).
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

När blockstreaming är aktiverat kan OpenClaw **slå ihop på varandra följande block‑chunkar**
innan de skickas. Detta minskar ”enradsspam” samtidigt som progressiv utdata bibehålls.

- Sammanfogning väntar på **inaktivitetsglapp** (`idleMs`) innan flush.
- Buffertar begränsas av `maxChars` och flushas om de överskrids.
- `minChars` förhindrar att pyttesmå fragment skickas innan tillräckligt med text ackumuleras
  (slutlig flush skickar alltid återstående text).
- Sammanfogningsseparator härleds från `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → mellanslag).
- Kanalöverskrivningar finns via `*.blockStreamingCoalesce` (inklusive konfig per konto).
- Standardvärdet för sammanfogning `minChars` höjs till 1500 för Signal/Slack/Discord om det inte åsidosätts.

## Mänsklig takt mellan block

När blockstreaming är aktiverat kan du lägga till en **randomiserad paus** mellan
blockrepliker (efter första blocket). Detta gör svar med flera bubblor mer naturliga.

- Konfig: `agents.defaults.humanDelay` (åsidosätt per agent via `agents.list[].humanDelay`).
- Lägen: `off` (standard), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Gäller endast **blockrepliker**, inte slutliga svar eller verktygssammanfattningar.

## ”Streama chunkar eller allt”

Detta motsvarar:

- **Streama chunkar:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (skicka löpande). Icke‑Telegram‑kanaler behöver också `*.blockStreaming: true`.
- **Streama allt i slutet:** `blockStreamingBreak: "message_end"` (flush en gång, eventuellt flera chunkar om mycket långt).
- **Ingen blockstreaming:** `blockStreamingDefault: "off"` (endast slutligt svar).

**Kanalnotis:** För icke‑Telegram‑kanaler är blockstreaming **av om inte**
`*.blockStreaming` uttryckligen sätts till `true`. Telegram kan streama utkast
(`channels.telegram.streamMode`) utan blockrepliker.

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
