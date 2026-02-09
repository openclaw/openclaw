---
summary: "Streaming- en chunkinggedrag (blokantwoorden, conceptstreaming, limieten)"
read_when:
  - Uitleggen hoe streaming of chunking werkt op kanalen
  - Blokstreaming of kanaal-chunkinggedrag wijzigen
  - Dubbele/vroege blokantwoorden of conceptstreaming debuggen
title: "Streaming en Chunking"
---

# Streaming + chunking

OpenClaw heeft twee afzonderlijke “streaming”-lagen:

- **Blokstreaming (kanalen):** verstuurt voltooide **blokken** terwijl de assistent schrijft. Dit zijn normale kanaalberichten (geen token-delta’s).
- **Token-achtig streamen (alleen Telegram):** werkt een **conceptbubbel** bij met gedeeltelijke tekst tijdens het genereren; het definitieve bericht wordt aan het einde verzonden.

Er is vandaag **geen echte tokenstreaming** naar externe kanaalberichten. Telegram-conceptstreaming is het enige oppervlak met gedeeltelijke streaming.

## Blokstreaming (kanaalberichten)

Blokstreaming verstuurt assistentuitvoer in grove stukken zodra deze beschikbaar komen.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legenda:

- `text_delta/events`: modelstreamgebeurtenissen (kunnen schaars zijn voor niet-streamende modellen).
- `chunker`: `EmbeddedBlockChunker` past min/max-grenzen + breekvoorkeur toe.
- `channel send`: daadwerkelijke uitgaande berichten (blokantwoorden).

**Bedieningselementen:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (standaard uit).
- Kanaaloverschrijvingen: `*.blockStreaming` (en varianten per account) om `"on"`/`"off"` per kanaal te forceren.
- `agents.defaults.blockStreamingBreak`: `"text_end"` of `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (samengevoegde gestreamde blokken vóór verzending).
- Harde kanaallimiet: `*.textChunkLimit` (bijv. `channels.whatsapp.textChunkLimit`).
- Kanaal-chunkmodus: `*.chunkMode` (`length` standaard, `newline` splitst op lege regels (paragraafgrenzen) vóór lengte-chunking).
- Discord soft cap: `channels.discord.maxLinesPerMessage` (standaard 17) splitst hoge antwoorden om UI-afkapping te voorkomen.

**Grenssemantiek:**

- `text_end`: stream blokken zodra de chunker uitzendt; flush bij elke `text_end`.
- `message_end`: wacht tot het assistentbericht klaar is en flush daarna de gebufferde uitvoer.

`message_end` gebruikt nog steeds de chunker als de gebufferde tekst groter is dan `maxChars`, zodat het aan het einde meerdere chunks kan uitsturen.

## Chunking-algoritme (lage/hoge grenzen)

Blok-chunking is geïmplementeerd door `EmbeddedBlockChunker`:

- **Lage grens:** niet uitsturen totdat buffer >= `minChars` (tenzij geforceerd).
- **Hoge grens:** splitsingen verkiezen vóór `maxChars`; indien geforceerd, splitsen bij `maxChars`.
- **Breekvoorkeur:** `paragraph` → `newline` → `sentence` → `whitespace` → harde breuk.
- **Code fences:** nooit binnen fences splitsen; wanneer geforceerd bij `maxChars`, de fence sluiten en opnieuw openen om Markdown geldig te houden.

`maxChars` wordt geklemd aan de kanaal-`textChunkLimit`, zodat je kanaalspecifieke limieten niet kunt overschrijden.

## Samenvoegen (gestreamde blokken combineren)

Wanneer blokstreaming is ingeschakeld, kan OpenClaw **opeenvolgende blokchunks samenvoegen**
voordat ze worden verzonden. Dit vermindert “single-line spam” terwijl toch
progressieve uitvoer wordt geboden.

- Samenvoegen wacht op **inactiviteitsgaten** (`idleMs`) voordat wordt geflusht.
- Buffers worden begrensd door `maxChars` en flushen wanneer ze deze overschrijden.
- `minChars` voorkomt dat piepkleine fragmenten worden verzonden totdat er genoeg tekst is opgebouwd
  (de laatste flush verzendt altijd resterende tekst).
- De joiner wordt afgeleid van `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → spatie).
- Kanaaloverschrijvingen zijn beschikbaar via `*.blockStreamingCoalesce` (inclusief configuraties per account).
- De standaard samenvoeg-`minChars` wordt verhoogd naar 1500 voor Signal/Slack/Discord, tenzij overschreven.

## Mensachtige pacing tussen blokken

Wanneer blokstreaming is ingeschakeld, kun je een **gerandomiseerde pauze** toevoegen tussen
blokantwoorden (na het eerste blok). Dit laat antwoorden met meerdere bubbels
natuurlijker aanvoelen.

- Config: `agents.defaults.humanDelay` (per agent te overschrijven via `agents.list[].humanDelay`).
- Modi: `off` (standaard), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Geldt alleen voor **blokantwoorden**, niet voor definitieve antwoorden of tool-samenvattingen.

## “Chunks streamen of alles”

Deze kaarten naar:

- **Chunks streamen:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (uitzenden terwijl je bezig bent). Niet-Telegram-kanalen hebben ook `*.blockStreaming: true` nodig.
- **Alles aan het einde streamen:** `blockStreamingBreak: "message_end"` (één keer flushen, mogelijk meerdere chunks als het erg lang is).
- **Geen blokstreaming:** `blockStreamingDefault: "off"` (alleen definitief antwoord).

**Kanaalopmerking:** Voor niet-Telegram-kanalen staat blokstreaming **uit tenzij**
`*.blockStreaming` expliciet is ingesteld op `true`. Telegram kan concepten streamen
(`channels.telegram.streamMode`) zonder blokantwoorden.

Herinnering aan configlocatie: de standaardwaarden voor `blockStreaming*` staan onder
`agents.defaults`, niet in de rootconfig.

## Telegram-conceptstreaming (token-achtig)

Telegram is het enige kanaal met conceptstreaming:

- Gebruikt Bot API `sendMessageDraft` in **privéchats met topics**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: conceptupdates met de nieuwste streamtekst.
  - `block`: conceptupdates in gechunkte blokken (dezelfde chunkerregels).
  - `off`: geen conceptstreaming.
- Concept-chunkconfig (alleen voor `streamMode: "block"`): `channels.telegram.draftChunk` (standaardwaarden: `minChars: 200`, `maxChars: 800`).
- Conceptstreaming staat los van blokstreaming; blokantwoorden staan standaard uit en worden alleen ingeschakeld door `*.blockStreaming: true` op niet-Telegram-kanalen.
- Het definitieve antwoord is nog steeds een normaal bericht.
- `/reasoning stream` schrijft redenering in de conceptbubbel (alleen Telegram).

Wanneer conceptstreaming actief is, schakelt OpenClaw blokstreaming voor dat antwoord uit om dubbele streaming te voorkomen.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legenda:

- `sendMessageDraft`: Telegram-conceptbubbel (geen echt bericht).
- `final reply`: normaal Telegram-bericht verzenden.
