---
summary: "Cron-jobb + väckningar för Gateways schemaläggare"
read_when:
  - Schemaläggning av bakgrundsjobb eller väckningar
  - Koppla automation som ska köras med eller parallellt med heartbeats
  - Välja mellan heartbeat och cron för schemalagda uppgifter
title: "Cron-jobb"
---

# Cron-jobb (Gateway-schemaläggare)

> **Cron vs Heartbeat?** Se [Cron vs Heartbeat](/automation/cron-vs-heartbeat) för vägledning om när du ska använda respektive.

Cron är Gateways inbyggda schemaläggare. Det kvarstår jobb, väcker agenten vid
rätt tid, och kan eventuellt leverera utdata tillbaka till en chatt.

Om du vill _”kör detta varje morgon”_ eller _”peta agenten om 20 minuter”_ är cron mekanismen.

Felsökning: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron körs **inuti Gateway** (inte inuti modellen).
- Jobb sparas under `~/.openclaw/cron/` så omstarter inte tappar scheman.
- Två körsätt:
  - **Huvudsession**: köa en systemhändelse och kör sedan vid nästa heartbeat.
  - **Isolerad**: kör ett dedikerat agentvarv i `cron:<jobId>`, med leverans (annonsera som standard eller ingen).
- Väckningar är förstklassiga: ett jobb kan begära ”väck nu” vs ”nästa heartbeat”.

## Snabbstart (handlingsbar)

Skapa en engångspåminnelse, verifiera att den finns och kör den omedelbart:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Schemalägg ett återkommande isolerat jobb med leverans:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Tool-call-motsvarigheter (Gateway cron-verktyg)

För de kanoniska JSON-formerna och exempel, se [JSON-schema för tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Var cron-jobb lagras

Cron jobb kvarstår på Gateway-värden på `~/.openclaw/cron/jobs.json` som standard.
Gateway laddar filen till minne och skriver den tillbaka vid ändringar, så manuella redigeringar
är bara säkra när Gateway stoppas. Föredrar `openclaw cron add/edit` eller cron
tool call API för ändringar.

## Nybörjarvänlig översikt

Tänk på ett cron-jobb som: **när** det ska köras + **vad** det ska göra.

1. **Välj ett schema**
   - Engångspåminnelse → `schedule.kind = "at"` (CLI: `--at`)
   - Återkommande jobb → `schedule.kind = "every"` eller `schedule.kind = "cron"`
   - Om din ISO-tidsstämpel saknar tidszon behandlas den som **UTC**.

2. **Välj var det körs**
   - `sessionTarget: "main"` → kör under nästa heartbeat med huvudkontext.
   - `sessionTarget: "isolated"` → kör ett dedikerat agentvarv i `cron:<jobId>`.

3. **Välj payload**
   - Huvudsession → `payload.kind = "systemEvent"`
   - Isolerad session → `payload.kind = "agentTurn"`

Valfritt: one-shot jobb (`schedule.kind = "at"`) ta bort efter framgång som standard. Ställ in
`deleteAfterRun: false` för att behålla dem (de kommer att inaktivera efter framgång).

## Begrepp

### Jobb

Ett cron-jobb är en lagrad post med:

- ett **schema** (när det ska köras),
- en **payload** (vad det ska göra),
- valfritt **leveransläge** (annonsera eller ingen).
- valfri **agentbindning** (`agentId`): kör jobbet under en specifik agent; om den
  saknas eller är okänd faller gateway tillbaka till standardagenten.

Jobb identifieras av en stabil `jobId` (används av CLI/Gateway API).
I agent verktygssamtal är `jobId` kanoniskt; äldre `id` accepteras för kompatibilitet.
Ett skott jobb auto-ta bort efter framgång som standard; sätt `deleteAfterRun: false` för att behålla dem.

### Scheman

Cron stöder tre schematyper:

- `at`: engångstidpunkt via `schedule.at` (ISO 8601).
- `every`: fast intervall (ms).
- `cron`: 5-fälts cron-uttryck med valfri IANA-tidszon.

Cron uttryck använder `croner`. Om en tidszon utelämnas används Gateway-värdens
lokala tidszon.

### Huvud- vs isolerad körning

#### Huvudsession-jobb (systemhändelser)

Huvudjobben skapar en systemhändelse och väcker valfritt hjärtslag löparen.
De måste använda `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (standard): händelsen triggar en omedelbar heartbeat-körning.
- `wakeMode: "next-heartbeat"`: händelsen väntar till nästa schemalagda heartbeat.

Detta är den bästa passformen när du vill ha den normala hjärtslag prompt + main-session sammanhang.
Se [Heartbeat](/gateway/heartbeat).

#### Isolerade jobb (dedikerade cron-sessioner)

Isolerade jobb kör ett dedikerat agentvarv i session `cron:<jobId>`.

Viktiga beteenden:

- Prompten prefixeras med `[cron:<jobId> <job name>]` för spårbarhet.
- Varje körning startar ett **nytt sessions-id** (ingen tidigare konversation följer med).
- Standardbeteende: om `delivery` utelämnas annonserar isolerade jobb en sammanfattning (`delivery.mode = "announce"`).
- `delivery.mode` (endast isolerad) väljer vad som händer:
  - `announce`: leverera en sammanfattning till målkanalen och posta en kort sammanfattning till huvudsessionen.
  - `none`: endast internt (ingen leverans, ingen sammanfattning i huvudsessionen).
- `wakeMode` styr när sammanfattningen i huvudsessionen postas:
  - `now`: omedelbar heartbeat.
  - `next-heartbeat`: väntar till nästa schemalagda heartbeat.

Använd isolerade jobb för bullriga, frekventa eller ”bakgrundssysslor” som inte bör spamma
din huvudchatthistorik.

### Payload-former (vad som körs)

Två payload-typer stöds:

- `systemEvent`: endast huvudsession, routad via heartbeat-prompten.
- `agentTurn`: endast isolerad session, kör ett dedikerat agentvarv.

Vanliga `agentTurn`-fält:

- `message`: obligatorisk textprompt.
- `model` / `thinking`: valfria åsidosättningar (se nedan).
- `timeoutSeconds`: valfri timeout-åsidosättning.

Leveranskonfig (endast isolerade jobb):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` eller en specifik kanal.
- `delivery.to`: kanalspecifikt mål (telefon/chatt/kanal-id).
- `delivery.bestEffort`: undvik att misslyckas jobbet om annonseringsleverans misslyckas.

Meddela leverans undertrycker meddelandeverktyget skickar för körningen; använd `delivery.channel`/`delivery.to`
för att rikta chatten istället. När `delivery.mode = "none"`, ingen sammanfattning publiceras på huvudsessionen.

Om `delivery` utelämnas för isolerade jobb, använder OpenClaw som standard `announce`.

#### Flöde för annonseringsleverans

När `delivery.mode = "announce"` levererar cron direkt via de utgående kanaladaptrarna.
Huvudagenten snurras inte upp för att tillverka eller vidarebefordra budskapet.

Beteendedetaljer:

- Innehåll: leveransen använder den isolerade körningens utgående payloads (text/media) med normal chunkning och
  kanalspecifik formatering.
- Endast-heartbeat-svar (`HEARTBEAT_OK` utan verkligt innehåll) levereras inte.
- Om den isolerade körningen redan skickade ett meddelande till samma mål via meddelandeverktyget hoppas leveransen över
  för att undvika dubletter.
- Saknade eller ogiltiga leveransmål gör att jobbet misslyckas om inte `delivery.bestEffort = true`.
- En kort sammanfattning postas till huvudsessionen endast när `delivery.mode = "announce"`.
- Sammanfattningen i huvudsessionen respekterar `wakeMode`: `now` triggar en omedelbar heartbeat och
  `next-heartbeat` väntar till nästa schemalagda heartbeat.

### Modell- och tänkande-åsidosättningar

Isolerade jobb (`agentTurn`) kan åsidosätta modell och tänkenivå:

- `model`: Leverantör/modellsträng (t.ex., `anthropic/claude-sonnet-4-20250514`) eller alias (t.ex., `opus`)
- `thinking`: Tänkenivå (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; endast GPT-5.2 + Codex-modeller)

Obs: Du kan ställa in `model` på huvudjobben också, men det ändrar den delade huvudmodellen
session. Vi rekommenderar modellersättningar endast för isolerade jobb för att undvika
oväntade sammanhangsskift.

Prioritetsordning för upplösning:

1. Jobb-payload-åsidosättning (högst)
2. Krokspecifika standardvärden (t.ex., `hooks.gmail.model`)
3. Agentkonfig-standard

### Leverans (kanal + mål)

Isolerade jobb kan leverera utdata till en kanal via den toppnivå `delivery`-konfigen:

- `delivery.mode`: `announce` (leverera en sammanfattning) eller `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: kanalspecifikt mottagarmål.

Leveranskonfig är endast giltig för isolerade jobb (`sessionTarget: "isolated"`).

Om `delivery.channel` eller `delivery.to` utelämnas kan cron falla tillbaka till huvudsessionens
”senaste rutt” (den senaste platsen där agenten svarade).

Påminnelser om målformat:

- Slack/Discord/Mattermost (plugin) mål bör använda explicita prefix (t.ex. `kanal:<id>`, `användare:<id>`) för att undvika tvetydighet.
- Telegram-ämnen bör använda `:topic:`-formen (se nedan).

#### Telegram-leveransmål (ämnen / forumtrådar)

Telegram stöder forumämnen via `message_thread_id`. För cron-leverans kan du koda
ämnet/tråden i `to`-fältet:

- `-1001234567890` (endast chatt-id)
- `-1001234567890:topic:123` (föredragen: explicit ämnesmarkör)
- `-1001234567890:123` (kortform: numeriskt suffix)

Prefixade mål som `telegram:...` / `telegram:group:...` accepteras också:

- `telegram:group:-1001234567890:topic:123`

## JSON-schema för tool calls

Använd dessa former när du anropar Gateway `cron.*` verktyg direkt (agentsamtal eller RPC).
CLI-flaggor accepterar mänskliga varaktigheter som "20m", men verktygssamtal bör använda en ISO 8601 sträng
för "schedule.at" och millisekunder för "schedule.everyM".

### cron.add params

Engångsjobb, huvudsession (systemhändelse):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Återkommande, isolerat jobb med leverans:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Noteringar:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), eller `cron` (`expr`, valfri `tz`).
- `schedule.at` accepterar ISO 8601 (tidszon valfri; behandlas som UTC när den utelämnas).
- `everyMs` är millisekunder.
- `sessionTarget` måste vara `"main"` eller `"isolated"` och måste matcha `payload.kind`.
- Valfria fält: `agentId`, `description`, `enabled`, `deleteAfterRun` (standard true för `at`),
  `delivery`.
- `wakeMode` är som standard `"now"` när det utelämnas.

### cron.update params

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Noteringar:

- `jobId` är kanoniskt; `id` accepteras för kompatibilitet.
- Använd `agentId: null` i patchen för att rensa en agentbindning.

### cron.run och cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Lagring & historik

- Jobblager: `~/.openclaw/cron/jobs.json` (Gateway-hanterad JSON).
- Körhistorik: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-rensas).
- Åsidosätt lagringssökväg: `cron.store` i konfig.

## Konfiguration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Inaktivera cron helt:

- `cron.enabled: false` (konfig)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI-snabbstart

Engångspåminnelse (UTC ISO, auto-raderas efter lyckad körning):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Engångspåminnelse (huvudsession, väck omedelbart):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Återkommande isolerat jobb (annonsera till WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Återkommande isolerat jobb (leverera till ett Telegram-ämne):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Isolerat jobb med modell- och tänkande-åsidosättning:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Agentval (multi-agent-uppsättningar):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manuell körning (force är standard, använd `--due` för att endast köra när det är dags):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Redigera ett befintligt jobb (patcha fält):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Körhistorik:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Omedelbar systemhändelse utan att skapa ett jobb:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API-yta

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force eller due), `cron.runs`
  För omedelbara systemhändelser utan jobb, använd [`openclaw system event`](/cli/system).

## Felsökning

### ”Inget körs”

- Kontrollera att cron är aktiverat: `cron.enabled` och `OPENCLAW_SKIP_CRON`.
- Kontrollera att Gateway körs kontinuerligt (cron körs inuti Gateway-processen).
- För `cron`-scheman: bekräfta tidszon (`--tz`) vs värdens tidszon.

### Ett återkommande jobb fortsätter att fördröjas efter fel

- OpenClaw tillämpar exponentiell återförsöks-backoff för återkommande jobb efter på varandra följande fel:
  30 s, 1 min, 5 min, 15 min, därefter 60 min mellan försök.
- Backoff återställs automatiskt efter nästa lyckade körning.
- Engångsjobb (`at`) inaktiveras efter en terminal körning (`ok`, `error` eller `skipped`) och gör inga återförsök.

### Telegram levererar till fel plats

- För forumämnen, använd `-100…:topic:<id>` så att det är explicit och entydigt.
- Om du ser `telegram:...`-prefix i loggar eller lagrade ”senaste rutt”-mål är det normalt;
  cron-leverans accepterar dem och tolkar fortfarande ämnes-id korrekt.
