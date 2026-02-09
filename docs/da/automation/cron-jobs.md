---
summary: "Cron-jobs + wakeups for Gateway-planlæggeren"
read_when:
  - Planlægning af baggrundsjob eller wakeups
  - Sammenkobling af automatisering, der skal køre med eller sideløbende med heartbeats
  - Valg mellem heartbeat og cron til planlagte opgaver
title: "Cron-jobs"
---

# Cron-jobs (Gateway scheduler)

> **Cron vs Heartbeat?** Se [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for vejledning i, hvornår du skal bruge hver.

Cron er Gatewayens indbyggede scheduler. Det fortsætter job, vækker agenten på
det rigtige tidspunkt, og kan eventuelt levere output tilbage til en chat.

Hvis du vil _“kør dette hver morgen”_ eller _“prik agenten om 20 minutter”_,
er cron mekanismen.

Fejlfinding: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron kører **inde i Gateway** (ikke inde i modellen).
- Jobs persisteres under `~/.openclaw/cron/`, så genstarter ikke mister planer.
- To udførelsesstile:
  - **Hovedsession**: sæt en systemhændelse i kø, og kør derefter på næste heartbeat.
  - **Isoleret**: kør en dedikeret agenttur i `cron:<jobId>`, med levering (annoncér som standard eller ingen).
- Wakeups er førsteklasses: et job kan anmode om “vågn nu” vs “næste heartbeat”.

## Hurtig start (handlingsorienteret)

Opret en engangspåmindelse, bekræft at den findes, og kør den med det samme:

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

Planlæg et tilbagevendende isoleret job med levering:

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

## Tool-call-ækvivalenter (Gateway cron tool)

For de kanoniske JSON-former og eksempler, se [JSON-skema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Hvor cron-jobs gemmes

Cron jobs are persisted on the Gateway host at `~/.openclaw/cron/jobs.json` as default.
Gateway indlæser filen i hukommelsen og skriver den tilbage på ændringer, så manuelle redigeringer
er kun sikre, når Gateway er stoppet. Foretræk `openclaw cron add/edit` eller cron
værktøjet kalder API for ændringer.

## Begyndervenligt overblik

Tænk på et cron-job som: **hvornår** det skal køre + **hvad** det skal gøre.

1. **Vælg en plan**
   - Engangspåmindelse → `schedule.kind = "at"` (CLI: `--at`)
   - Gentagende job → `schedule.kind = "every"` eller `schedule.kind = "cron"`
   - Hvis dit ISO-tidsstempel udelader en tidszone, behandles det som **UTC**.

2. **Vælg hvor det kører**
   - `sessionTarget: "main"` → kør under næste heartbeat med hovedkontekst.
   - `sessionTarget: "isolated"` → kør en dedikeret agenttur i `cron:<jobId>`.

3. **Vælg payload**
   - Hovedsession → `payload.kind = "systemEvent"`
   - Isoleret session → `payload.kind = "agentTurn"`

Valgfri: one-shot jobs (`schedule.kind = "at"`) delete after success as default. Sæt
`deleteAfterRun: false` for at beholde dem (de vil deaktivere efter succes).

## Begreber

### Jobs

Et cron-job er en gemt post med:

- en **plan** (hvornår det skal køre),
- en **payload** (hvad det skal gøre),
- valgfri **leveringstilstand** (annoncér eller ingen).
- valgfri **agentbinding** (`agentId`): kør jobbet under en specifik agent; hvis
  den mangler eller er ukendt, falder gateway tilbage til standardagenten.

Jobs identificeres ved en stabil `jobId` (bruges af CLI/Gateway API'er).
I agent værktøj opkald, `jobId` er kanonisk; arv `id` er accepteret for kompatibilitet.
One-shot jobs auto-delete after success as default; set `deleteAfterRun: false` for at holde dem.

### Planer

Cron understøtter tre plan-typer:

- `at`: engangstidsstempel via `schedule.at` (ISO 8601).
- `every`: fast interval (ms).
- `cron`: 5-felts cron-udtryk med valgfri IANA-tidszone.

Cron udtryk bruge `croner`. Hvis en tidszone er udeladt, Gateway værts
lokale tidszone anvendes.

### Hoved- vs isoleret udførelse

#### Jobs i hovedsession (systemhændelser)

Vigtigste job kø en systembegivenhed og eventuelt vække hjerteslag løberen.
De skal bruge `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (standard): hændelsen udløser et øjeblikkeligt heartbeat-kørsel.
- `wakeMode: "next-heartbeat"`: hændelsen venter på næste planlagte heartbeat.

Dette er den bedste pasform, når du vil have den normale hjerteslag prompt + main-session kontekst.
Se [Heartbeat](/gateway/heartbeat).

#### Isolerede jobs (dedikerede cron-sessioner)

Isolerede jobs kører en dedikeret agenttur i session `cron:<jobId>`.

Nøgleadfærd:

- Prompten prefikses med `[cron:<jobId> <job name>]` for sporbarhed.
- Hver kørsel starter en **frisk session-id** (ingen overførsel af tidligere samtale).
- Standardadfærd: hvis `delivery` udelades, annoncerer isolerede jobs et resumé (`delivery.mode = "announce"`).
- `delivery.mode` (kun isoleret) vælger hvad der sker:
  - `announce`: lever et resumé til målkanalen og post et kort resumé til hovedsessionen.
  - `none`: kun internt (ingen levering, intet hovedsessions-resumé).
- `wakeMode` styrer hvornår hovedsessions-resuméet postes:
  - `now`: øjeblikkeligt heartbeat.
  - `next-heartbeat`: venter på næste planlagte heartbeat.

Brug isolerede jobs til støjende, hyppige eller “baggrundsopgaver”, der ikke bør spamme
din hovedchat-historik.

### Payload-former (hvad der kører)

To payload-typer understøttes:

- `systemEvent`: kun hovedsession, routet gennem heartbeat-prompten.
- `agentTurn`: kun isoleret session, kører en dedikeret agenttur.

Fælles `agentTurn`-felter:

- `message`: påkrævet tekstprompt.
- `model` / `thinking`: valgfrie overrides (se nedenfor).
- `timeoutSeconds`: valgfrit timeout-override.

Leveringskonfiguration (kun isolerede jobs):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` eller en specifik kanal.
- `delivery.to`: kanalspecifikt mål (telefon/chat/kanal-id).
- `delivery.bestEffort`: undgå at fejle jobbet, hvis annoncelevering fejler.

Annoncere levering undertrykker besked værktøj sender til kørsel; brug `delivery.channel`/`delivery.to`
til at målrette chatten i stedet. Når `delivery.mode = "none"`, ingen resumé er bogført til hovedsessionen.

Hvis `delivery` udelades for isolerede jobs, sætter OpenClaw som standard `announce`.

#### Flow for annoncelevering

Når `delivery.mode = "announce"`, cron leverer direkte via de udgående kanaladaptere.
Hovedagenten er ikke spundet op til at fremstille eller videresende budskabet.

Adfærdsdetaljer:

- Indhold: levering bruger den isolerede kørsels udgående payloads (tekst/medier) med normal chunking og
  kanalformatering.
- Kun-heartbeat-svar (`HEARTBEAT_OK` uden reelt indhold) leveres ikke.
- Hvis den isolerede kørsel allerede sendte en besked til samme mål via message tool, springes levering over
  for at undgå dubletter.
- Manglende eller ugyldige leveringsmål fejler jobbet, medmindre `delivery.bestEffort = true`.
- Et kort resumé postes kun til hovedsessionen, når `delivery.mode = "announce"`.
- Hovedsessions-resuméet respekterer `wakeMode`: `now` udløser et øjeblikkeligt heartbeat og
  `next-heartbeat` venter på næste planlagte heartbeat.

### Model- og thinking-overrides

Isolerede jobs (`agentTurn`) kan override model og thinking-niveau:

- `model`: Provider/model string (f.eks. `anthropic/claude-sonnet-4-20250514`) eller alias (f.eks. `opus`)
- `thinking`: Thinking-niveau (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; kun GPT-5.2 + Codex-modeller)

Bemærk: Du kan også indstille `model` på main-session job, men det ændrer den delte primære
session model. Vi anbefaler model tilsidesætter kun for isolerede job for at undgå
uventede kontekstskift.

Opløsningsprioritet:

1. Job payload-override (højeste)
2. Hook-specifikke standarder (f.eks. `hooks.gmail.model`)
3. Agentkonfigurationens standard

### Levering (kanal + mål)

Isolerede jobs kan levere output til en kanal via den øverste `delivery`-konfiguration:

- `delivery.mode`: `announce` (lever et resumé) eller `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: kanalspecifikt modtagermål.

Leveringskonfiguration er kun gyldig for isolerede jobs (`sessionTarget: "isolated"`).

Hvis `delivery.channel` eller `delivery.to` udelades, kan cron falde tilbage til hovedsessionens
“sidste rute” (det sidste sted agenten svarede).

Påmindelser om målformat:

- Slack/Discord/Mattermost (plugin) mål bør bruge eksplicitte præfikser (f.eks. `kanal:<id>`, `user:<id>`) for at undgå tvetydighed.
- Telegram-emner bør bruge `:topic:`-formen (se nedenfor).

#### Telegram-leveringsmål (emner / forumtråde)

Telegram understøtter forumemner via `message_thread_id`. For cron levering, kan du indkode
emnet/tråden i 'to'-felt:

- `-1001234567890` (kun chat-id)
- `-1001234567890:topic:123` (foretrukken: eksplicit emnemarkør)
- `-1001234567890:123` (kortform: numerisk suffiks)

Præfiksede mål som `telegram:...` / `telegram:group:...` accepteres også:

- `telegram:group:-1001234567890:topic:123`

## JSON-skema for tool calls

Brug disse former, når du ringer til Gateway `cron.*` værktøjer direkte (agent værktøj opkald eller RPC).
CLI flag accepterer menneskelige varigheder som `20m`, men værktøj opkald skal bruge en ISO 8601 streng
for `schedule.at` og millisekunder for `schedule.everyMs`.

### cron.add params

Engangsjob i hovedsession (systemhændelse):

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

Tilbagevendende isoleret job med levering:

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

Noter:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), eller `cron` (`expr`, valgfri `tz`).
- `schedule.at` accepterer ISO 8601 (tidszone valgfri; behandles som UTC, når udeladt).
- `everyMs` er millisekunder.
- `sessionTarget` skal være `"main"` eller `"isolated"` og skal matche `payload.kind`.
- Valgfrie felter: `agentId`, `description`, `enabled`, `deleteAfterRun` (standard er true for `at`),
  `delivery`.
- `wakeMode` er som standard `"now"`, når udeladt.

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

Noter:

- `jobId` er kanonisk; `id` accepteres for kompatibilitet.
- Brug `agentId: null` i patchen for at rydde en agentbinding.

### cron.run og cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Lager & historik

- Joblager: `~/.openclaw/cron/jobs.json` (Gateway-administreret JSON).
- Kørselslog: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, automatisk beskåret).
- Override lagersti: `cron.store` i konfiguration.

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

Deaktivér cron helt:

- `cron.enabled: false` (konfiguration)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI-hurtigstart

Engangspåmindelse (UTC ISO, automatisk sletning efter succes):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Engangspåmindelse (hovedsession, væk øjeblikkeligt):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Tilbagevendende isoleret job (annoncér til WhatsApp):

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

Tilbagevendende isoleret job (lever til et Telegram-emne):

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

Isoleret job med model- og thinking-override:

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

Agentvalg (multi-agent-opsætninger):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manuel kørsel (force er standard, brug `--due` for kun at køre, når forfaldent):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Redigér et eksisterende job (patch felter):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Kørselshistorik:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Øjeblikkelig systemhændelse uden at oprette et job:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API-overflade

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force eller due), `cron.runs`
  For øjeblikkelige systemhændelser uden et job, brug [`openclaw system event`](/cli/system).

## Fejlfinding

### “Intet kører”

- Tjek at cron er aktiveret: `cron.enabled` og `OPENCLAW_SKIP_CRON`.
- Tjek at Gateway kører kontinuerligt (cron kører inde i Gateway-processen).
- For `cron`-planer: bekræft tidszone (`--tz`) vs værtsmaskinens tidszone.

### Et tilbagevendende job bliver ved med at blive forsinket efter fejl

- OpenClaw anvender eksponentiel retry-backoff for tilbagevendende jobs efter på hinanden følgende fejl:
  30s, 1m, 5m, 15m, derefter 60m mellem forsøg.
- Backoff nulstilles automatisk efter næste succesfulde kørsel.
- Engangsjobs (`at`) deaktiveres efter en terminal kørsel (`ok`, `error` eller `skipped`) og forsøges ikke igen.

### Telegram leverer til det forkerte sted

- For forumemner, brug `-100…:topic:<id>`, så det er eksplicit og entydigt.
- Hvis du ser `telegram:...`-præfikser i logs eller gemte “sidste rute”-mål, er det normalt;
  cron-levering accepterer dem og parser stadig emne-id’er korrekt.
