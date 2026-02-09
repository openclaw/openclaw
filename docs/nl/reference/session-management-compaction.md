---
summary: "Diepgaande uitleg: sessie-opslag + transcripties, levenscyclus en (auto)compactie-internals"
read_when:
  - Je moet sessie-id’s, transcript-JSONL of velden in sessions.json debuggen
  - Je wijzigt het gedrag van auto-compactie of voegt “pre-compactie”-huishoudtaken toe
  - Je wilt geheugen-flushes of stille systeembeurten implementeren
title: "Diepgaande uitleg sessiebeheer"
---

# Sessiebeheer & Compactie (Diepgaande uitleg)

Dit document legt uit hoe OpenClaw sessies end-to-end beheert:

- **Sessierouting** (hoe inkomende berichten worden toegewezen aan een `sessionKey`)
- **Sessiestore** (`sessions.json`) en wat deze bijhoudt
- **Transcriptpersistentie** (`*.jsonl`) en de structuur ervan
- **Transcript-hygiëne** (provider-specifieke correcties vóór runs)
- **Contextlimieten** (contextvenster versus bijgehouden tokens)
- **Compactie** (handmatige + auto-compactie) en waar je pre-compactiewerk kunt inhaken
- **Stille huishoudtaken** (bijv. geheugenschrijvingen die geen voor de gebruiker zichtbare uitvoer mogen produceren)

Wil je eerst een overzicht op hoger niveau, begin dan met:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Bron van waarheid: de Gateway

OpenClaw is ontworpen rond één enkel **Gateway-proces** dat de sessiestatus beheert.

- UI’s (macOS-app, web Control UI, TUI) moeten de Gateway raadplegen voor sessielijsten en tokentellingen.
- In remote-modus staan sessiebestanden op de externe host; “je lokale Mac-bestanden controleren” weerspiegelt niet wat de Gateway gebruikt.

---

## Twee persistentielagen

OpenClaw bewaart sessies in twee lagen:

1. **Sessiestore (`sessions.json`)**
   - Sleutel/waarde-map: `sessionKey -> SessionEntry`
   - Klein, muteerbaar, veilig om te bewerken (of items te verwijderen)
   - Houdt sessiemetadata bij (huidige sessie-id, laatste activiteit, toggles, tokentellers, enz.)

2. **Transcript (`<sessionId>.jsonl`)**
   - Alleen-aanvulbaar transcript met boomstructuur (items hebben `id` + `parentId`)
   - Slaat het daadwerkelijke gesprek + tool-aanroepen + compactiesamenvattingen op
   - Wordt gebruikt om de modelcontext voor toekomstige beurten opnieuw op te bouwen

---

## Locaties op schijf

Per agent, op de Gateway-host:

- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripties: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram-topic-sessies: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw resolveert deze via `src/config/sessions.ts`.

---

## Sessiesleutels (`sessionKey`)

Een `sessionKey` identificeert _welke conversatie-emmer_ je gebruikt (routing + isolatie).

Veelvoorkomende patronen:

- Hoofd/direct chat (per agent): `agent:<agentId>:<mainKey>` (standaard `main`)
- Groep: `agent:<agentId>:<channel>:group:<id>`
- Kamer/kanaal (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` of `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (tenzij overschreven)

De canonieke regels zijn gedocumenteerd op [/concepts/session](/concepts/session).

---

## Sessie-id’s (`sessionId`)

Elke `sessionKey` wijst naar een huidige `sessionId` (het transcriptbestand dat de conversatie voortzet).

Vuistregels:

- **Reset** (`/new`, `/reset`) maakt een nieuwe `sessionId` voor die `sessionKey`.
- **Dagelijkse reset** (standaard 4:00 uur lokale tijd op de Gateway-host) maakt een nieuwe `sessionId` bij het eerstvolgende bericht na de resetgrens.
- **Inactiviteitsverval** (`session.reset.idleMinutes` of legacy `session.idleMinutes`) maakt een nieuwe `sessionId` wanneer een bericht arriveert na het inactiviteitsvenster. Als dagelijkse + inactiviteit beide zijn geconfigureerd, wint degene die het eerst verloopt.

Implementatiedetail: de beslissing gebeurt in `initSessionState()` in `src/auto-reply/reply/session.ts`.

---

## Schema van de sessiestore (`sessions.json`)

Het waardetype van de store is `SessionEntry` in `src/config/sessions.ts`.

Belangrijke velden (niet uitputtend):

- `sessionId`: huidige transcript-id (bestandsnaam wordt hiervan afgeleid tenzij `sessionFile` is ingesteld)
- `updatedAt`: tijdstempel van laatste activiteit
- `sessionFile`: optionele expliciete overschrijving van het transcriptpad
- `chatType`: `direct | group | room` (helpt UI’s en verzendbeleid)
- `provider`, `subject`, `room`, `space`, `displayName`: metadata voor groeps-/kanaallabeling
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (per-sessie-overschrijving)
- Modelselectie:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Tokentellers (best-effort / provider-afhankelijk):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: hoe vaak auto-compactie voor deze sessiesleutel is voltooid
- `memoryFlushAt`: tijdstempel van de laatste pre-compactie geheugen-flush
- `memoryFlushCompactionCount`: compactietelling toen de laatste flush draaide

De store is veilig om te bewerken, maar de Gateway is de autoriteit: deze kan items herschrijven of opnieuw hydrateren terwijl sessies lopen.

---

## Transcriptstructuur (`*.jsonl`)

Transcripties worden beheerd door `@mariozechner/pi-coding-agent`’s `SessionManager`.

Het bestand is JSONL:

- Eerste regel: sessieheader (`type: "session"`, bevat `id`, `cwd`, `timestamp`, optioneel `parentSession`)
- Daarna: sessie-items met `id` + `parentId` (boom)

Opvallende itemtypes:

- `message`: user/assistant/toolResult-berichten
- `custom_message`: door extensies geïnjecteerde berichten die _wel_ de modelcontext ingaan (kunnen verborgen zijn voor de UI)
- `custom`: extensiestatus die _niet_ de modelcontext ingaat
- `compaction`: persistente compactiesamenvatting met `firstKeptEntryId` en `tokensBefore`
- `branch_summary`: persistente samenvatting bij het navigeren van een boomtak

OpenClaw “repareert” transcripties bewust **niet**; de Gateway gebruikt `SessionManager` om ze te lezen/schrijven.

---

## Contextvensters versus bijgehouden tokens

Twee verschillende concepten zijn belangrijk:

1. **Modelcontextvenster**: harde limiet per model (tokens zichtbaar voor het model)
2. **Sessiestore-tellers**: rollende statistieken die in `sessions.json` worden geschreven (gebruikt voor /status en dashboards)

Als je limieten afstelt:

- Het contextvenster komt uit de modelcatalogus (en kan via config worden overschreven).
- `contextTokens` in de store is een runtime-schatting/rapportagewaarde; behandel dit niet als een strikte garantie.

Zie voor meer [/token-use](/reference/token-use).

---

## Compactie: wat het is

Compactie vat oudere conversatie samen in een persistente `compaction`-entry in het transcript en houdt recente berichten intact.

Na compactie zien toekomstige beurten:

- De compactiesamenvatting
- Berichten na `firstKeptEntryId`

Compactie is **persistent** (in tegenstelling tot sessie-pruning). Zie [/concepts/session-pruning](/concepts/session-pruning).

---

## Wanneer auto-compactie plaatsvindt (Pi-runtime)

In de ingebedde Pi-agent wordt auto-compactie in twee gevallen getriggerd:

1. **Overflow-herstel**: het model retourneert een context-overflowfout → compacteren → opnieuw proberen.
2. **Drempelonderhoud**: na een succesvolle beurt, wanneer:

`contextTokens > contextWindow - reserveTokens`

Waarbij:

- `contextWindow` het contextvenster van het model is
- `reserveTokens` gereserveerde ruimte is voor prompts + de volgende modeluitvoer

Dit zijn Pi-runtime-semantiek (OpenClaw consumeert de events, maar Pi beslist wanneer te compacteren).

---

## Compactie-instellingen (`reserveTokens`, `keepRecentTokens`)

De compactie-instellingen van Pi staan in de Pi-instellingen:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw dwingt ook een veiligheidsvloer af voor ingebedde runs:

- Als `compaction.reserveTokens < reserveTokensFloor`, verhoogt OpenClaw dit.
- Standaardvloer is `20000` tokens.
- Stel `agents.defaults.compaction.reserveTokensFloor: 0` in om de vloer uit te schakelen.
- Als deze al hoger is, laat OpenClaw het ongemoeid.

Waarom: voldoende ruimte laten voor meerbeurten-“huishoudtaken” (zoals geheugenschrijvingen) voordat compactie onvermijdelijk wordt.

Implementatie: `ensurePiCompactionReserveTokens()` in `src/agents/pi-settings.ts`
(aangeroepen vanuit `src/agents/pi-embedded-runner.ts`).

---

## Voor de gebruiker zichtbare oppervlakken

Je kunt compactie en sessiestatus waarnemen via:

- `/status` (in elke chatsessie)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose-modus: `🧹 Auto-compaction complete` + compactietelling

---

## Stille huishoudtaken (`NO_REPLY`)

OpenClaw ondersteunt “stille” beurten voor achtergrondtaken waarbij de gebruiker geen tussentijdse uitvoer mag zien.

Conventie:

- De assistant begint zijn uitvoer met `NO_REPLY` om aan te geven “geen antwoord aan de gebruiker afleveren”.
- OpenClaw stript/onderdrukt dit in de afleverlaag.

Sinds `2026.1.10` onderdrukt OpenClaw ook **concept-/typestreaming** wanneer een gedeeltelijke chunk begint met `NO_REPLY`, zodat stille operaties geen gedeeltelijke uitvoer midden in de beurt lekken.

---

## Pre-compactie “geheugen-flush” (geïmplementeerd)

Doel: vóórdat auto-compactie plaatsvindt, een stille agentische beurt uitvoeren die duurzame
status naar schijf schrijft (bijv. `memory/YYYY-MM-DD.md` in de agent-werkruimte), zodat compactie geen kritieke context kan
wissen.

OpenClaw gebruikt de **pre-drempel-flush**-aanpak:

1. Monitor sessiecontextgebruik.
2. Wanneer dit een “zachte drempel” overschrijdt (onder Pi’s compactiedrempel), voer een stille
   “schrijf nu geheugen”-instructie uit naar de agent.
3. Gebruik `NO_REPLY` zodat de gebruiker niets ziet.

Config (`agents.defaults.compaction.memoryFlush`):

- `enabled` (standaard: `true`)
- `softThresholdTokens` (standaard: `4000`)
- `prompt` (gebruikersbericht voor de flush-beurt)
- `systemPrompt` (extra systeemprompt die voor de flush-beurt wordt toegevoegd)

Notities:

- De standaardprompt/systeemprompt bevat een `NO_REPLY`-hint om aflevering te onderdrukken.
- De flush draait eenmaal per compactiecyclus (bijgehouden in `sessions.json`).
- De flush draait alleen voor ingebedde Pi-sessies (CLI-backends slaan dit over).
- De flush wordt overgeslagen wanneer de sessiewerkruimte alleen-lezen is (`workspaceAccess: "ro"` of `"none"`).
- Zie [Memory](/concepts/memory) voor de indeling van werkruimtebestanden en schrijfpatronen.

Pi biedt ook een `session_before_compact`-hook in de extensie-API, maar OpenClaw’s
flush-logica leeft vandaag aan de Gateway-kant.

---

## Checklist voor problemen oplossen

- Sessiesleutel onjuist? Begin met [/concepts/session](/concepts/session) en bevestig de `sessionKey` in `/status`.
- Store- versus transcript-mismatch? Bevestig de Gateway-host en het store-pad uit `openclaw status`.
- Compactiespam? Controleer:
  - modelcontextvenster (te klein)
  - compactie-instellingen (`reserveTokens` te hoog voor het modelvenster kan eerdere compactie veroorzaken)
  - tool-result-bloat: schakel sessie-pruning in of stel het af
- Lekken stille beurten? Bevestig dat het antwoord begint met `NO_REPLY` (exact token) en dat je op een build zit die de streaming-onderdrukkingsfix bevat.
