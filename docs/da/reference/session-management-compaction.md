---
summary: "Dybdegående gennemgang: sessionslager + transskripter, livscyklus og (auto)kompakterings‑internals"
read_when:
  - Du skal debugge session-id’er, transcript JSONL eller felter i sessions.json
  - Du ændrer auto-kompakteringsadfærd eller tilføjer “pre-compaction” housekeeping
  - Du vil implementere memory flushes eller tavse systemturns
title: "Dybdegående gennemgang af sessionstyring"
x-i18n:
  source_path: reference/session-management-compaction.md
  source_hash: 6344a9eaf8797eb4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:06Z
---

# Sessionstyring & kompaktering (dybdegående)

Dette dokument forklarer, hvordan OpenClaw håndterer sessioner fra ende til ende:

- **Sessionsrouting** (hvordan indgående beskeder mappes til en `sessionKey`)
- **Sessionslager** (`sessions.json`) og hvad det sporer
- **Persistens af transskripter** (`*.jsonl`) og deres struktur
- **Transcript-hygiejne** (udbyderspecifikke rettelser før kørsler)
- **Kontekstgrænser** (kontekstvindue vs. sporede tokens)
- **Kompaktering** (manuel + auto-kompaktering) og hvor man kan hooke pre-compaction-arbejde
- **Tavs housekeeping** (fx memory-skrivninger, der ikke bør give bruger-synligt output)

Hvis du vil have et overblik på højere niveau først, så start med:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Sandhedens kilde: Gateway

OpenClaw er designet omkring én **Gateway-proces**, der ejer sessionstilstanden.

- UI’er (macOS-app, web Control UI, TUI) bør forespørge Gateway om sessionslister og token-tællinger.
- I fjern-tilstand ligger sessionsfiler på den fjernværtsmaskine; “at tjekke dine lokale Mac-filer” afspejler ikke, hvad Gateway bruger.

---

## To persistenslag

OpenClaw persisterer sessioner i to lag:

1. **Sessionslager (`sessions.json`)**
   - Nøgle/værdi-kort: `sessionKey -> SessionEntry`
   - Lille, mutérbar, sikker at redigere (eller slette poster)
   - Sporer session-metadata (aktuel session-id, seneste aktivitet, toggles, token-tællere m.m.)

2. **Transskript (`<sessionId>.jsonl`)**
   - Append-only transskript med træstruktur (poster har `id` + `parentId`)
   - Gemmer den faktiske samtale + værktøjskald + kompakteringsresuméer
   - Bruges til at genopbygge modelkonteksten for fremtidige turns

---

## Placeringer på disk

Per agent, på gateway-værten:

- Lager: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transskripter: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram-emnesessioner: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw resolver disse via `src/config/sessions.ts`.

---

## Sessionsnøgler (`sessionKey`)

En `sessionKey` identificerer _hvilken samtalebehold­er_ du er i (routing + isolation).

Almindelige mønstre:

- Hoved/direkte chat (per agent): `agent:<agentId>:<mainKey>` (standard `main`)
- Gruppe: `agent:<agentId>:<channel>:group:<id>`
- Rum/kanal (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` eller `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (medmindre tilsidesat)

De kanoniske regler er dokumenteret på [/concepts/session](/concepts/session).

---

## Session-id’er (`sessionId`)

Hver `sessionKey` peger på en aktuel `sessionId` (transskriptfilen, der fortsætter samtalen).

Tommelfingerregler:

- **Reset** (`/new`, `/reset`) opretter en ny `sessionId` for den `sessionKey`.
- **Dagligt reset** (standard kl. 04:00 lokal tid på gateway-værten) opretter en ny `sessionId` ved den næste besked efter reset-grænsen.
- **Idle-udløb** (`session.reset.idleMinutes` eller legacy `session.idleMinutes`) opretter en ny `sessionId`, når en besked ankommer efter idle-vinduet. Når både daglig og idle er konfigureret, vinder den, der udløber først.

Implementeringsdetalje: beslutningen sker i `initSessionState()` i `src/auto-reply/reply/session.ts`.

---

## Sessionslagerets skema (`sessions.json`)

Lagerets værditype er `SessionEntry` i `src/config/sessions.ts`.

Nøglefelter (ikke udtømmende):

- `sessionId`: aktuel transskript-id (filnavn afledes heraf, medmindre `sessionFile` er sat)
- `updatedAt`: tidsstempel for seneste aktivitet
- `sessionFile`: valgfri eksplicit tilsidesættelse af transskriptsti
- `chatType`: `direct | group | room` (hjælper UI’er og sende-politik)
- `provider`, `subject`, `room`, `space`, `displayName`: metadata til gruppe/kanal-mærkning
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (per-session-override)
- Modelvalg:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Token-tællere (best-effort / udbyderafhængige):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: hvor ofte auto-kompaktering er gennemført for denne sessionsnøgle
- `memoryFlushAt`: tidsstempel for seneste pre-compaction memory flush
- `memoryFlushCompactionCount`: kompakteringstælling, da den seneste flush kørte

Lageret er sikkert at redigere, men Gateway er autoriteten: den kan genskrive eller rehydrere poster, efterhånden som sessioner kører.

---

## Transskriptstruktur (`*.jsonl`)

Transskripter administreres af `@mariozechner/pi-coding-agent`’s `SessionManager`.

Filen er JSONL:

- Første linje: sessionsheader (`type: "session"`, inkluderer `id`, `cwd`, `timestamp`, valgfri `parentSession`)
- Derefter: sessionsposter med `id` + `parentId` (træ)

Bemærkelsesværdige posttyper:

- `message`: bruger/assistant/toolResult-beskeder
- `custom_message`: extension-injicerede beskeder, der _indgår_ i modelkontekst (kan skjules i UI)
- `custom`: extension-tilstand, der _ikke_ indgår i modelkontekst
- `compaction`: persisteret kompakteringsresumé med `firstKeptEntryId` og `tokensBefore`
- `branch_summary`: persisteret resumé ved navigation af en trægren

OpenClaw “retter” bevidst **ikke** transskripter; Gateway bruger `SessionManager` til at læse/skrive dem.

---

## Kontekstvinduer vs. sporede tokens

To forskellige begreber er vigtige:

1. **Modelkontekstvindue**: hård grænse pr. model (tokens synlige for modellen)
2. **Sessionslager-tællere**: rullende statistikker skrevet i `sessions.json` (bruges til /status og dashboards)

Hvis du tuner grænser:

- Kontekstvinduet kommer fra modelkataloget (og kan tilsidesættes via konfiguration).
- `contextTokens` i lageret er en runtime-estimat/rapporteringsværdi; behandl den ikke som en streng garanti.

Se mere på [/token-use](/reference/token-use).

---

## Kompaktering: hvad det er

Kompaktering opsummerer ældre samtale i en persisteret `compaction`-post i transskriptet og bevarer de seneste beskeder intakte.

Efter kompaktering ser fremtidige turns:

- Kompakteringsresuméet
- Beskeder efter `firstKeptEntryId`

Kompaktering er **persistent** (i modsætning til session pruning). Se [/concepts/session-pruning](/concepts/session-pruning).

---

## Hvornår auto-kompaktering sker (Pi-runtime)

I den indlejrede Pi-agent udløses auto-kompaktering i to tilfælde:

1. **Overflow-recovery**: modellen returnerer en context overflow-fejl → kompaktér → prøv igen.
2. **Tærskel-vedligeholdelse**: efter et vellykket turn, når:

`contextTokens > contextWindow - reserveTokens`

Hvor:

- `contextWindow` er modellens kontekstvindue
- `reserveTokens` er headroom reserveret til prompts + næste modeloutput

Dette er Pi-runtime-semantik (OpenClaw forbruger hændelserne, men Pi afgør, hvornår der kompakteres).

---

## Indstillinger for kompaktering (`reserveTokens`, `keepRecentTokens`)

Pi’s kompakteringsindstillinger ligger i Pi-indstillinger:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw håndhæver også et sikkerhedsgulv for indlejrede kørsler:

- Hvis `compaction.reserveTokens < reserveTokensFloor`, hæver OpenClaw den.
- Standardgulvet er `20000` tokens.
- Sæt `agents.defaults.compaction.reserveTokensFloor: 0` for at deaktivere gulvet.
- Hvis den allerede er højere, lader OpenClaw den være.

Hvorfor: efterlade nok headroom til flerturns “housekeeping” (som memory-skrivninger), før kompaktering bliver uundgåelig.

Implementering: `ensurePiCompactionReserveTokens()` i `src/agents/pi-settings.ts`
(kaldt fra `src/agents/pi-embedded-runner.ts`).

---

## Bruger-synlige flader

Du kan observere kompaktering og sessionstilstand via:

- `/status` (i enhver chatsession)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose-tilstand: `🧹 Auto-compaction complete` + kompakteringstælling

---

## Tavs housekeeping (`NO_REPLY`)

OpenClaw understøtter “tavse” turns til baggrundsopgaver, hvor brugeren ikke bør se mellemliggende output.

Konvention:

- Assistenten starter sit output med `NO_REPLY` for at indikere “lever ikke et svar til brugeren”.
- OpenClaw fjerner/undertrykker dette i leveringslaget.

Fra og med `2026.1.10` undertrykker OpenClaw også **kladde-/typing-streaming**, når en delvis chunk begynder med `NO_REPLY`, så tavse operationer ikke lækker delvist output midt i et turn.

---

## Pre-compaction “memory flush” (implementeret)

Mål: før auto-kompaktering sker, kør et tavst agentisk turn, der skriver vedvarende
tilstand til disk (fx `memory/YYYY-MM-DD.md` i agentens workspace), så kompaktering ikke kan
slette kritisk kontekst.

OpenClaw bruger **pre-threshold flush**-tilgangen:

1. Overvåg sessionens kontekstforbrug.
2. Når det krydser en “blød tærskel” (under Pi’s kompakteringstærskel), kør en tavs
   “write memory now”-direktiv til agenten.
3. Brug `NO_REPLY`, så brugeren intet ser.

Konfiguration (`agents.defaults.compaction.memoryFlush`):

- `enabled` (standard: `true`)
- `softThresholdTokens` (standard: `4000`)
- `prompt` (brugermeddelelse for flush-turnet)
- `systemPrompt` (ekstra systemprompt, der tilføjes for flush-turnet)

Noter:

- Standardprompt/systemprompt inkluderer et `NO_REPLY`-hint for at undertrykke levering.
- Flush kører én gang pr. kompakteringscyklus (sporet i `sessions.json`).
- Flush kører kun for indlejrede Pi-sessioner (CLI-backends springer den over).
- Flush springes over, når sessionens workspace er skrivebeskyttet (`workspaceAccess: "ro"` eller `"none"`).
- Se [Memory](/concepts/memory) for workspace-fil-layout og skrive-mønstre.

Pi eksponerer også et `session_before_compact`-hook i extension-API’et, men OpenClaws
flush-logik ligger på Gateway-siden i dag.

---

## Fejlfindingstjekliste

- Forkert sessionsnøgle? Start med [/concepts/session](/concepts/session) og bekræft `sessionKey` i `/status`.
- Uoverensstemmelse mellem lager og transskript? Bekræft gateway-værten og lagerstien fra `openclaw status`.
- Kompakteringsspam? Tjek:
  - modelkontekstvindue (for lille)
  - kompakteringsindstillinger (`reserveTokens` for høj i forhold til modelvinduet kan give tidligere kompaktering)
  - tool-result-bloat: aktivér/justér session pruning
- Tavse turns lækker? Bekræft at svaret starter med `NO_REPLY` (præcis token), og at du er på en build, der inkluderer streaming-undertrykkelsesfixet.
