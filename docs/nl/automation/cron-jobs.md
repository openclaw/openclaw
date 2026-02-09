---
summary: "Cronjobs + wake-ups voor de Gateway-scheduler"
read_when:
  - Achtergrondtaken of wake-ups plannen
  - Automatisering koppelen die met of naast heartbeats moet draaien
  - Beslissen tussen heartbeat en cron voor geplande taken
title: "Cronjobs"
---

# Cronjobs (Gateway-scheduler)

> **Cron vs Heartbeat?** Zie [Cron vs Heartbeat](/automation/cron-vs-heartbeat) voor richtlijnen over wanneer je welke gebruikt.

Cron is de ingebouwde scheduler van de Gateway. Hij bewaart jobs persistent,
wekt de agent op het juiste moment en kan optioneel uitvoer terugsturen naar een chat.

Als je _“dit elke ochtend uitvoeren”_ of _“de agent over 20 minuten een seintje geven”_
wilt, dan is cron het juiste mechanisme.

Problemen oplossen: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron draait **binnen de Gateway** (niet binnen het model).
- Jobs worden persistent opgeslagen onder `~/.openclaw/cron/`, zodat herstarts schema’s niet verliezen.
- Twee uitvoeringsstijlen:
  - **Hoofdsessie**: een systeemevenement in de wachtrij zetten en uitvoeren bij de volgende heartbeat.
  - **Geïsoleerd**: een speciale agent-turn uitvoeren in `cron:<jobId>`, met levering (standaard aankondigen of geen).
- Wake-ups zijn eersteklas: een job kan “nu wekken” aanvragen i.p.v. “volgende heartbeat”.

## Snelle start (actiegericht)

Maak een eenmalige herinnering, controleer dat deze bestaat en voer hem direct uit:

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

Plan een terugkerende geïsoleerde job met levering:

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

## Tool-call equivalenten (Gateway cron tool)

Voor de canonieke JSON-vormen en voorbeelden, zie [JSON-schema voor tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Waar cronjobs worden opgeslagen

Cronjobs worden standaard persistent opgeslagen op de Gateway-host in `~/.openclaw/cron/jobs.json`.
De Gateway laadt het bestand in het geheugen en schrijft het terug bij wijzigingen, dus handmatige bewerkingen
zijn alleen veilig wanneer de Gateway is gestopt. Geef de voorkeur aan `openclaw cron add/edit` of de cron
tool-call API voor wijzigingen.

## Beginner-vriendelijk overzicht

Denk aan een cronjob als: **wanneer** uitvoeren + **wat** doen.

1. **Kies een schema**
   - Eenmalige herinnering → `schedule.kind = "at"` (CLI: `--at`)
   - Terugkerende job → `schedule.kind = "every"` of `schedule.kind = "cron"`
   - Als je ISO-tijdstempel geen tijdzone bevat, wordt deze behandeld als **UTC**.

2. **Kies waar deze draait**
   - `sessionTarget: "main"` → uitvoeren tijdens de volgende heartbeat met hoofdcontext.
   - `sessionTarget: "isolated"` → een speciale agent-turn uitvoeren in `cron:<jobId>`.

3. **Kies de payload**
   - Hoofdsessie → `payload.kind = "systemEvent"`
   - Geïsoleerde sessie → `payload.kind = "agentTurn"`

Optioneel: eenmalige jobs (`schedule.kind = "at"`) worden standaard na succes verwijderd. Stel
`deleteAfterRun: false` in om ze te behouden (ze worden na succes uitgeschakeld).

## Concepten

### Jobs

Een cronjob is een opgeslagen record met:

- een **schema** (wanneer deze moet draaien),
- een **payload** (wat deze moet doen),
- een optionele **leveringsmodus** (aankondigen of geen).
- een optionele **agentbinding** (`agentId`): voer de job uit onder een specifieke agent; indien
  ontbrekend of onbekend, valt de Gateway terug op de standaardagent.

Jobs worden geïdentificeerd door een stabiele `jobId` (gebruikt door CLI/Gateway-API’s).
In agent tool calls is `jobId` canoniek; het legacy `id` wordt geaccepteerd voor compatibiliteit.
Eenmalige jobs worden standaard na succes automatisch verwijderd; stel `deleteAfterRun: false` in om ze te behouden.

### Schema’s

Cron ondersteunt drie soorten schema’s:

- `at`: eenmalige tijdstempel via `schedule.at` (ISO 8601).
- `every`: vaste interval (ms).
- `cron`: 5-veld cron-expressie met optionele IANA-tijdzone.

Cron-expressies gebruiken `croner`. Als een tijdzone ontbreekt, wordt de lokale
tijdzone van de Gateway-host gebruikt.

### Hoofd- vs geïsoleerde uitvoering

#### Hoofdsessie-jobs (systeemevenementen)

Hoofd-jobs plaatsen een systeemevenement in de wachtrij en wekken optioneel de heartbeat-runner.
Ze moeten `payload.kind = "systemEvent"` gebruiken.

- `wakeMode: "now"` (standaard): het evenement triggert een onmiddellijke heartbeat-run.
- `wakeMode: "next-heartbeat"`: het evenement wacht op de volgende geplande heartbeat.

Dit is het beste geschikt wanneer je de normale heartbeat-prompt + hoofdsessie-context wilt.
Zie [Heartbeat](/gateway/heartbeat).

#### Geïsoleerde jobs (speciale cron-sessies)

Geïsoleerde jobs draaien een speciale agent-turn in sessie `cron:<jobId>`.

Belangrijke gedragingen:

- De prompt krijgt het voorvoegsel `[cron:<jobId> <job name>]` voor traceerbaarheid.
- Elke run start met een **verse sessie-id** (geen eerdere gesprekscontext).
- Standaardgedrag: als `delivery` ontbreekt, kondigen geïsoleerde jobs een samenvatting aan (`delivery.mode = "announce"`).
- `delivery.mode` (alleen geïsoleerd) bepaalt wat er gebeurt:
  - `announce`: lever een samenvatting aan het doelkanaal en plaats een korte samenvatting in de hoofdsessie.
  - `none`: alleen intern (geen levering, geen hoofdsessie-samenvatting).
- `wakeMode` bepaalt wanneer de hoofdsessie-samenvatting wordt geplaatst:
  - `now`: onmiddellijke heartbeat.
  - `next-heartbeat`: wacht tot de volgende geplande heartbeat.

Gebruik geïsoleerde jobs voor lawaaierige, frequente of “achtergrondtaken” die je
hoofdchatgeschiedenis niet moeten vervuilen.

### Payload-vormen (wat wordt uitgevoerd)

Er worden twee soorten payloads ondersteund:

- `systemEvent`: alleen hoofdsessie, gerouteerd via de heartbeat-prompt.
- `agentTurn`: alleen geïsoleerde sessie, draait een speciale agent-turn.

Veelvoorkomende `agentTurn`-velden:

- `message`: vereiste tekstprompt.
- `model` / `thinking`: optionele overrides (zie hieronder).
- `timeoutSeconds`: optionele timeout-override.

Leveringsconfiguratie (alleen geïsoleerde jobs):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` of een specifiek kanaal.
- `delivery.to`: kanaalspecifiek doel (telefoon/chat/kanaal-id).
- `delivery.bestEffort`: voorkom dat de job faalt als aankondigingslevering mislukt.

Aankondigingslevering onderdrukt het verzenden via messaging-tools voor deze run; gebruik `delivery.channel`/`delivery.to`
om direct de chat te targeten. Wanneer `delivery.mode = "none"`, wordt er geen samenvatting in de hoofdsessie geplaatst.

Als `delivery` ontbreekt voor geïsoleerde jobs, gebruikt OpenClaw standaard `announce`.

#### Kondig levering stroom aan

Wanneer `delivery.mode = "announce"`, levert cron direct via de outbound-kanaaladapters.
De hoofdagent wordt niet gestart om het bericht te formuleren of door te sturen.

Gedragsdetails:

- Inhoud: levering gebruikt de outbound-payloads (tekst/media) van de geïsoleerde run met normale chunking en
  kanaalopmaak.
- Alleen-heartbeat-antwoorden (`HEARTBEAT_OK` zonder echte inhoud) worden niet geleverd.
- Als de geïsoleerde run al een bericht naar hetzelfde doel heeft gestuurd via de messaging-tool, wordt levering
  overgeslagen om duplicaten te voorkomen.
- Ontbrekende of ongeldige leveringsdoelen laten de job falen tenzij `delivery.bestEffort = true`.
- Een korte samenvatting wordt alleen in de hoofdsessie geplaatst wanneer `delivery.mode = "announce"`.
- De hoofdsessie-samenvatting respecteert `wakeMode`: `now` triggert een onmiddellijke heartbeat en
  `next-heartbeat` wacht op de volgende geplande heartbeat.

### Model- en thinking-overrides

Geïsoleerde jobs (`agentTurn`) kunnen het model en het thinking-niveau overriden:

- `model`: Provider/model-string (bijv. `anthropic/claude-sonnet-4-20250514`) of alias (bijv. `opus`)
- `thinking`: Thinking-niveau (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; alleen GPT-5.2 + Codex-modellen)

Let op: je kunt `model` ook instellen voor hoofdsessie-jobs, maar dat wijzigt het gedeelde
hoofdsessiemodel. We raden model-overrides alleen aan voor geïsoleerde jobs om
onverwachte contextverschuivingen te voorkomen.

Resolutieprioriteit:

1. Job-payload-override (hoogste)
2. Hook-specifieke standaardwaarden (bijv. `hooks.gmail.model`)
3. Agent-config-standaard

### Levering (kanaal + doel)

Geïsoleerde jobs kunnen uitvoer leveren aan een kanaal via de top-level `delivery`-config:

- `delivery.mode`: `announce` (lever een samenvatting) of `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: kanaalspecifiek ontvangerdoel.

Leveringsconfiguratie is alleen geldig voor geïsoleerde jobs (`sessionTarget: "isolated"`).

Als `delivery.channel` of `delivery.to` ontbreekt, kan cron terugvallen op de “laatste route”
van de hoofdsessie (de laatste plek waar de agent antwoordde).

Herinneringen voor doelformaten:

- Slack/Discord/Mattermost (plugin)-doelen moeten expliciete voorvoegsels gebruiken (bijv. `channel:<id>`, `user:<id>`) om ambiguïteit te voorkomen.
- Telegram-onderwerpen moeten de `:topic:`-vorm gebruiken (zie hieronder).

#### Telegram-leveringsdoelen (topics / forumthreads)

Telegram ondersteunt forumtopics via `message_thread_id`. Voor cron-levering kun je
het topic/thread coderen in het `to`-veld:

- `-1001234567890` (alleen chat-id)
- `-1001234567890:topic:123` (aanbevolen: expliciete topic-marker)
- `-1001234567890:123` (verkorte notatie: numerieke suffix)

Voorafgefixeerde doelen zoals `telegram:...` / `telegram:group:...` worden ook geaccepteerd:

- `telegram:group:-1001234567890:topic:123`

## JSON-schema voor tool calls

Gebruik deze vormen wanneer je Gateway-`cron.*`-tools direct aanroept (agent tool calls of RPC).
CLI-flags accepteren leesbare duurwaarden zoals `20m`, maar tool calls moeten een ISO 8601-string
gebruiken voor `schedule.at` en milliseconden voor `schedule.everyMs`.

### cron.add params

Eenmalige, hoofdsessie-job (systeemevenement):

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

Terugkerende, geïsoleerde job met levering:

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

Notities:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), of `cron` (`expr`, optioneel `tz`).
- `schedule.at` accepteert ISO 8601 (tijdzone optioneel; behandeld als UTC wanneer weggelaten).
- `everyMs` is in milliseconden.
- `sessionTarget` moet `"main"` of `"isolated"` zijn en moet overeenkomen met `payload.kind`.
- Optionele velden: `agentId`, `description`, `enabled`, `deleteAfterRun` (standaard true voor `at`),
  `delivery`.
- `wakeMode` is standaard `"now"` wanneer weggelaten.

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

Notities:

- `jobId` is canoniek; `id` wordt geaccepteerd voor compatibiliteit.
- Gebruik `agentId: null` in de patch om een agentbinding te wissen.

### cron.run en cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Opslag & geschiedenis

- Jobopslag: `~/.openclaw/cron/jobs.json` (Gateway-beheerde JSON).
- Run-geschiedenis: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, automatisch opgeschoond).
- Overschrijf opslagpad: `cron.store` in config.

## Configuratie

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Cron volledig uitschakelen:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI-snelstart

Eenmalige herinnering (UTC ISO, automatisch verwijderd na succes):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Eenmalige herinnering (hoofdsessie, direct wekken):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Terugkerende geïsoleerde job (aankondigen naar WhatsApp):

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

Terugkerende geïsoleerde job (leveren aan een Telegram-topic):

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

Geïsoleerde job met model- en thinking-override:

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

Agentselectie (multi-agent-opstellingen):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Handmatige run (force is standaard, gebruik `--due` om alleen te draaien wanneer verschuldigd):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Een bestaande job bewerken (velden patchen):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Run-geschiedenis:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Onmiddellijk systeemevenement zonder een job aan te maken:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API-oppervlak

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force of due), `cron.runs`
  Voor onmiddellijke systeemevenementen zonder job, gebruik [`openclaw system event`](/cli/system).

## Problemen oplossen

### “Er draait niets”

- Controleer of cron is ingeschakeld: `cron.enabled` en `OPENCLAW_SKIP_CRON`.
- Controleer of de Gateway continu draait (cron draait binnen het Gateway-proces).
- Voor `cron`-schema’s: bevestig de tijdzone (`--tz`) versus de hosttijdzone.

### Een terugkerende job blijft vertragen na fouten

- OpenClaw past exponentiële retry-backoff toe voor terugkerende jobs na opeenvolgende fouten:
  30s, 1m, 5m, 15m, daarna 60m tussen retries.
- Backoff wordt automatisch gereset na de volgende succesvolle run.
- Eenmalige (`at`) jobs schakelen uit na een terminale run (`ok`, `error` of `skipped`) en proberen niet opnieuw.

### Telegram levert op de verkeerde plek

- Gebruik voor forumtopics `-100…:topic:<id>`, zodat het expliciet en ondubbelzinnig is.
- Als je `telegram:...`-voorvoegsels ziet in logs of opgeslagen “laatste route”-doelen, is dat normaal;
  cron-levering accepteert ze en parseert topic-id’s nog steeds correct.
