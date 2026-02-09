---
summary: "Fördjupning: sessionslagring + transkript, livscykel och internals för (auto)kompaktering"
read_when:
  - Du behöver felsöka sessions-id:n, transcript JSONL eller fält i sessions.json
  - Du ändrar beteendet för automatisk kompaktering eller lägger till ”pre-kompaktering”-städning
  - Du vill implementera minnesflushar eller tysta systemvändor
title: "Fördjupning i sessionshantering"
---

# Sessionshantering och kompaktering (fördjupning)

Det här dokumentet förklarar hur OpenClaw hanterar sessioner från början till slut:

- **Sessionsroutning** (hur inkommande meddelanden mappar till en `sessionKey`)
- **Sessionslagring** (`sessions.json`) och vad den spårar
- **Persistens av transkript** (`*.jsonl`) och dess struktur
- **Transkripthygien** (leverantörsspecifika korrigeringar före körningar)
- **Kontextgränser** (kontextfönster vs spårade tokens)
- **Kompaktering** (manuell + automatisk kompaktering) och var man kan haka in arbete före kompaktering
- **Tyst städning** (t.ex. minnesskrivningar som inte ska ge användarsynlig utdata)

Om du vill ha en mer övergripande översikt först, börja med:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Sanningskälla: Gateway

OpenClaw är designat kring en enda **Gateway-process** som äger sessionstillståndet.

- UI:er (macOS-app, webbaserat Control UI, TUI) ska fråga Gateway om sessionslistor och tokenräkningar.
- I fjärrläge ligger sessionsfilerna på fjärrvärden; att ”kontrollera dina lokala Mac-filer” återspeglar inte vad Gateway använder.

---

## Två persistenslager

OpenClaw persisterar sessioner i två lager:

1. **Sessionslagring (`sessions.json`)**
   - Nyckel/värde-karta: `sessionKey -> SessionEntry`
   - Liten, muterbar, säker att redigera (eller radera poster)
   - Spårar sessionsmetadata (aktuellt sessions-id, senaste aktivitet, växlar, tokenräknare m.m.)

2. **Transkript (`<sessionId>.jsonl`)**
   - Append-only-transkript med trädstruktur (poster har `id` + `parentId`)
   - Lagrar den faktiska konversationen + verktygsanrop + kompakteringssammanfattningar
   - Används för att bygga upp modellkontexten för framtida vändor

---

## Platser på disk

Per agent, på Gateway-värden:

- Lagring: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transkript: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram-ämnessessioner: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw löser dessa via `src/config/sessions.ts`.

---

## Sessionsnycklar (`sessionKey`)

En `sessionKey` identifierar _vilken konversationshink_ du befinner dig i (routning + isolering).

Vanliga mönster:

- Huvud-/direktchatt (per agent): `agent:<agentId>:<mainKey>` (standard `main`)
- Grupp: `agent:<agentId>:<channel>:group:<id>`
- Rum/kanal (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` eller `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (om inte åsidosatt)

De kanoniska reglerna är dokumenterade på [/concepts/session](/concepts/session).

---

## Sessions-id:n (`sessionId`)

Varje `sessionKey` pekar på ett aktuellt `sessionId` (transkriptfilen som fortsätter konversationen).

Tumregler:

- **Återställning** (`/new`, `/reset`) skapar ett nytt `sessionId` för den `sessionKey`.
- **Daglig återställning** (standard 04:00 lokal tid på Gateway-värden) skapar ett nytt `sessionId` vid nästa meddelande efter återställningsgränsen.
- **Idle utgång** (`session.reset.idleMinutes` eller äldre `session.idleMinutes`) skapar en ny `sessionId` när ett meddelande kommer efter tomgångsfönstret. När dagligen + inaktiv är båda konfigurerade, vilket som löper ut första vinner.

Implementationsdetalj: beslutet sker i `initSessionState()` i `src/auto-reply/reply/session.ts`.

---

## Schema för sessionslagring (`sessions.json`)

Lagringens värdetyp är `SessionEntry` i `src/config/sessions.ts`.

Viktiga fält (inte uttömmande):

- `sessionId`: aktuellt transkript-id (filnamn härleds från detta om inte `sessionFile` är satt)
- `updatedAt`: tidsstämpel för senaste aktivitet
- `sessionFile`: valfri explicit åsidosättning av transkriptsökväg
- `chatType`: `direct | group | room` (hjälper UI:er och sändpolicy)
- `provider`, `subject`, `room`, `space`, `displayName`: metadata för grupp-/kanaletikettering
- Växlar:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (åsidosättning per session)
- Modellval:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Tokenräknare (best-effort / leverantörsberoende):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: hur ofta automatisk kompaktering har slutförts för denna sessionsnyckel
- `memoryFlushAt`: tidsstämpel för senaste pre-kompakterings-minnesflush
- `memoryFlushCompactionCount`: kompakteringsräkning när senaste flush kördes

Lagringen är säker att redigera, men Gateway är auktoriteten: den kan skriva om eller rehydrera poster när sessioner körs.

---

## Transkriptstruktur (`*.jsonl`)

Transkript hanteras av `@mariozechner/pi-coding-agent`s `SessionManager`.

Filen är JSONL:

- Första raden: sessionshuvud (`type: "session"`, inkluderar `id`, `cwd`, `timestamp`, valfri `parentSession`)
- Därefter: sessionsposter med `id` + `parentId` (träd)

Anmärkningsvärda posttyper:

- `message`: användar-/assistent-/toolResult-meddelanden
- `custom_message`: tilläggsinjicerade meddelanden som _kommer in_ i modellkontext (kan döljas från UI)
- `custom`: tilläggstillstånd som _inte_ kommer in i modellkontext
- `compaction`: persisterad kompakteringssammanfattning med `firstKeptEntryId` och `tokensBefore`
- `branch_summary`: persisterad sammanfattning vid navigering av en trädgren

OpenClaw ”fixar” medvetet **inte** transkript; Gateway använder `SessionManager` för att läsa/skriva dem.

---

## Kontextfönster vs spårade tokens

Två olika begrepp är viktiga:

1. **Modellens kontextfönster**: hård gräns per modell (tokens synliga för modellen)
2. **Räknare i sessionslagringen**: rullande statistik som skrivs till `sessions.json` (används för /status och dashboards)

Om du justerar gränser:

- Kontextfönstret kommer från modellkatalogen (och kan åsidosättas via konfig).
- `contextTokens` i lagringen är ett körtidsestimat/rapporteringsvärde; behandla det inte som en strikt garanti.

Mer information finns på [/token-use](/reference/token-use).

---

## Kompaktering: vad det är

Kompaktering sammanfattar äldre konversation till en persisterad `compaction`-post i transkriptet och behåller senaste meddelanden intakta.

Efter kompaktering ser framtida vändor:

- Kompakteringssammanfattningen
- Meddelanden efter `firstKeptEntryId`

Komprimering är **persistent** (till skillnad från sessionsbeskärning). Se [/concepts/session-pruning](/concepts/session-pruning).

---

## När automatisk kompaktering sker (Pi runtime)

I den inbäddade Pi-agenten triggas automatisk kompaktering i två fall:

1. **Återhämtning vid överskridande**: modellen returnerar ett fel om kontextöverskridande → kompakta → försök igen.
2. **Tröskelunderhåll**: efter en lyckad vända, när:

`contextTokens > contextWindow - reserveTokens`

Där:

- `contextWindow` är modellens kontextfönster
- `reserveTokens` är marginal reserverad för promptar + nästa modellutdata

Detta är semantik i Pi runtime (OpenClaw konsumerar händelserna, men Pi avgör när kompaktering ska ske).

---

## Inställningar för kompaktering (`reserveTokens`, `keepRecentTokens`)

Pis kompakteringsinställningar finns i Pi-inställningar:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw tillämpar också ett säkerhetsgolv för inbäddade körningar:

- Om `compaction.reserveTokens < reserveTokensFloor`, höjer OpenClaw det.
- Standardgolvet är `20000` tokens.
- Sätt `agents.defaults.compaction.reserveTokensFloor: 0` för att inaktivera golvet.
- Om det redan är högre lämnar OpenClaw det orört.

Varför: lämna tillräckligt med marginal för flervändors ”städning” (som minnesskrivningar) innan kompaktering blir oundviklig.

Implementering: `ensurePiCompactionReserveTokens()` i `src/agents/pi-settings.ts`
(anropas från `src/agents/pi-embedded-runner.ts`).

---

## Användarsynliga ytor

Du kan observera kompaktering och sessionstillstånd via:

- `/status` (i valfri chattsession)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Utförligt läge: `🧹 Auto-compaction complete` + kompakteringsräkning

---

## Tyst städning (`NO_REPLY`)

OpenClaw stöder ”tysta” vändor för bakgrundsuppgifter där användaren inte ska se mellanliggande utdata.

Konvention:

- Assistenten inleder sin utdata med `NO_REPLY` för att indikera ”leverera inget svar till användaren”.
- OpenClaw strimlar/undertrycker detta i leveranslagret.

Från och med `2026.1.10` undertrycker OpenClaw även **utkast-/skrivstreaming** när ett partiellt chunk börjar med `NO_REPLY`, så att tysta operationer inte läcker partiell utdata mitt i en vända.

---

## ”Minnesflush” före kompaktering (implementerad)

Mål: innan automatisk komprimering händer, kör en tyst agentic tur som skriver hållbar
tillstånd till disk (e. . `minne/YYY-MM-DD.md` i agentens arbetsyta) så komprimering kan inte
radera kritiska sammanhang.

OpenClaw använder metoden **pre-tröskel-flush**:

1. Övervaka sessionens kontextanvändning.
2. När den passerar en ”mjuk tröskel” (under Pis kompakteringströskel), kör en tyst
   ”skriv minne nu”-direktiv till agenten.
3. Använd `NO_REPLY` så att användaren inte ser något.

Konfig (`agents.defaults.compaction.memoryFlush`):

- `enabled` (standard: `true`)
- `softThresholdTokens` (standard: `4000`)
- `prompt` (användarmeddelande för flush-vändan)
- `systemPrompt` (extra systemprompt som läggs till för flush-vändan)

Noteringar:

- Standardprompt/systemprompt innehåller en `NO_REPLY`-hint för att undertrycka leverans.
- Flush körs en gång per kompakteringscykel (spåras i `sessions.json`).
- Flush körs endast för inbäddade Pi-sessioner (CLI-backends hoppar över den).
- Flush hoppas över när sessionens arbetsyta är skrivskyddad (`workspaceAccess: "ro"` eller `"none"`).
- Se [Memory](/concepts/memory) för arbetsytans fillayout och skrivmönster.

Pi exponerar också en `session_before_compact`-hook i tilläggs-API:t, men OpenClaws
flushlogik ligger i dag på Gateway-sidan.

---

## Felsökningschecklista

- Sessionsnyckel fel? Börja med [/concepts/session](/concepts/session) och bekräfta `sessionKey` i `/status`.
- Lagra vs utskrift felaktigt? Bekräfta Gateway-värden och butikssökvägen från `openclaw status`.
- Komprimering skräppost? Kontroll:
  - modellens kontextfönster (för litet)
  - kompakteringsinställningar (`reserveTokens` för högt i förhållande till modellfönstret kan orsaka tidigare kompaktering)
  - uppblåst tool-result: aktivera/justera session pruning
- Tysta svängar läckande? Bekräfta svaret börjar med `NO_REPLY` (exakt token) och du är på en byggnad som inkluderar strömmande dämpning fix.
