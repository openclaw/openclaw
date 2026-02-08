---
summary: "Mga cron job + wakeup para sa Gateway scheduler"
read_when:
  - Pag-iskedyul ng mga background job o wakeup
  - Pag-wire ng automation na dapat tumakbo kasama o kasabay ng mga heartbeat
  - Pagpapasya sa pagitan ng heartbeat at cron para sa mga naka-iskedyul na gawain
title: "Mga Cron Job"
x-i18n:
  source_path: automation/cron-jobs.md
  source_hash: d2f7bd6c542034b1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:50Z
---

# Mga cron job (Gateway scheduler)

> **Cron vs Heartbeat?** Tingnan ang [Cron vs Heartbeat](/automation/cron-vs-heartbeat) para sa gabay kung kailan gagamitin ang bawat isa.

Ang cron ay ang built-in scheduler ng Gateway. Pinapanatili nito ang mga job, ginigising ang agent sa tamang oras, at maaaring maghatid ng output pabalik sa isang chat kung nais.

Kung gusto mo ng _“patakbuhin ito tuwing umaga”_ o _“kalabitin ang agent pagkalipas ng 20 minuto”_, cron ang mekanismo.

Pag-troubleshoot: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Tumatakbo ang cron **sa loob ng Gateway** (hindi sa loob ng model).
- Ang mga job ay naka-persist sa ilalim ng `~/.openclaw/cron/` kaya hindi nawawala ang mga iskedyul kahit mag-restart.
- Dalawang istilo ng execution:
  - **Main session**: mag-enqueue ng system event, pagkatapos ay tumakbo sa susunod na heartbeat.
  - **Isolated**: magpatakbo ng hiwalay na agent turn sa `cron:<jobId>`, na may delivery (announce bilang default o none).
- First-class ang mga wakeup: maaaring humiling ang isang job ng “wake now” kumpara sa “next heartbeat”.

## Mabilis na pagsisimula (actionable)

Gumawa ng one-shot na paalala, i-verify na umiiral ito, at patakbuhin kaagad:

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

Mag-iskedyul ng umuulit na isolated job na may delivery:

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

## Mga katumbas na tool-call (Gateway cron tool)

Para sa canonical na mga hugis ng JSON at mga halimbawa, tingnan ang [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Saan naka-store ang mga cron job

Ang mga cron job ay naka-persist sa Gateway host sa `~/.openclaw/cron/jobs.json` bilang default.
Ini-load ng Gateway ang file sa memory at isinusulat pabalik kapag may pagbabago, kaya ligtas lamang ang manu-manong pag-edit kapag naka-stop ang Gateway. Mas mainam ang `openclaw cron add/edit` o ang cron tool call API para sa mga pagbabago.

## Beginner-friendly na pangkalahatang-ideya

Isipin ang isang cron job bilang: **kailan** tatakbo + **ano** ang gagawin.

1. **Pumili ng iskedyul**
   - One-shot na paalala → `schedule.kind = "at"` (CLI: `--at`)
   - Umuulit na job → `schedule.kind = "every"` o `schedule.kind = "cron"`
   - Kung ang ISO timestamp mo ay walang timezone, ituturing itong **UTC**.

2. **Pumili kung saan ito tatakbo**
   - `sessionTarget: "main"` → tumakbo sa susunod na heartbeat gamit ang main context.
   - `sessionTarget: "isolated"` → magpatakbo ng hiwalay na agent turn sa `cron:<jobId>`.

3. **Pumili ng payload**
   - Main session → `payload.kind = "systemEvent"`
   - Isolated session → `payload.kind = "agentTurn"`

Opsyonal: ang mga one-shot job (`schedule.kind = "at"`) ay nade-delete pagkatapos ng tagumpay bilang default. Itakda ang `deleteAfterRun: false` para panatilihin ang mga ito (magdi-disable sila pagkatapos ng tagumpay).

## Mga Konsepto

### Mga Job

Ang isang cron job ay isang naka-store na record na may:

- isang **schedule** (kailan ito dapat tumakbo),
- isang **payload** (ano ang dapat nitong gawin),
- opsyonal na **delivery mode** (announce o none).
- opsyonal na **agent binding** (`agentId`): patakbuhin ang job sa ilalim ng isang partikular na agent; kung wala o hindi kilala, babalik ang gateway sa default agent.

Ang mga job ay kinikilala sa pamamagitan ng isang stable na `jobId` (ginagamit ng CLI/Gateway APIs).
Sa agent tool calls, `jobId` ang canonical; tinatanggap ang legacy na `id` para sa compatibility.
Ang mga one-shot job ay awtomatikong nade-delete pagkatapos ng tagumpay bilang default; itakda ang `deleteAfterRun: false` para panatilihin ang mga ito.

### Mga Schedule

Sinusuportahan ng cron ang tatlong uri ng schedule:

- `at`: one-shot na timestamp gamit ang `schedule.at` (ISO 8601).
- `every`: fixed interval (ms).
- `cron`: 5-field na cron expression na may opsyonal na IANA timezone.

Gumagamit ang mga cron expression ng `croner`. Kapag walang timezone, ginagamit ang lokal na timezone ng Gateway host.

### Main vs isolated execution

#### Mga main session job (system events)

Nag-e-enqueue ang mga main job ng system event at opsyonal na ginising ang heartbeat runner.
Dapat nilang gamitin ang `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (default): nagti-trigger ang event ng agarang heartbeat run.
- `wakeMode: "next-heartbeat"`: naghihintay ang event sa susunod na naka-iskedyul na heartbeat.

Ito ang pinakamainam kapag gusto mo ang normal na heartbeat prompt + main-session context.
Tingnan ang [Heartbeat](/gateway/heartbeat).

#### Mga isolated job (dedicated cron sessions)

Ang mga isolated job ay nagpapatakbo ng hiwalay na agent turn sa session na `cron:<jobId>`.

Mahahalagang behavior:

- Ang prompt ay may prefix na `[cron:<jobId> <job name>]` para sa traceability.
- Bawat run ay nagsisimula ng **bagong session id** (walang dala-dalang nakaraang pag-uusap).
- Default na behavior: kung wala ang `delivery`, ang mga isolated job ay nag-a-announce ng buod (`delivery.mode = "announce"`).
- Pinipili ng `delivery.mode` (isolated-only) kung ano ang mangyayari:
  - `announce`: maghatid ng buod sa target na channel at mag-post ng maikling buod sa main session.
  - `none`: internal lamang (walang delivery, walang main-session summary).
- Kinokontrol ng `wakeMode` kung kailan magpo-post ang main-session summary:
  - `now`: agarang heartbeat.
  - `next-heartbeat`: naghihintay sa susunod na naka-iskedyul na heartbeat.

Gamitin ang mga isolated job para sa maiingay, madalas, o “background chores” na hindi dapat mag-spam sa iyong main chat history.

### Mga hugis ng payload (ano ang tumatakbo)

Dalawang uri ng payload ang sinusuportahan:

- `systemEvent`: main-session lamang, dinadaanan sa heartbeat prompt.
- `agentTurn`: isolated-session lamang, nagpapatakbo ng hiwalay na agent turn.

Mga karaniwang field ng `agentTurn`:

- `message`: kinakailangang text prompt.
- `model` / `thinking`: opsyonal na override (tingnan sa ibaba).
- `timeoutSeconds`: opsyonal na timeout override.

Config ng delivery (isolated job lamang):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` o isang partikular na channel.
- `delivery.to`: channel-specific na target (phone/chat/channel id).
- `delivery.bestEffort`: iwasang mag-fail ang job kung pumalya ang announce delivery.

Pinipigilan ng announce delivery ang mga messaging tool send para sa run; gamitin ang `delivery.channel`/`delivery.to` para i-target ang chat sa halip. Kapag `delivery.mode = "none"`, walang buod na ipo-post sa main session.

Kung wala ang `delivery` para sa mga isolated job, default ng OpenClaw ang `announce`.

#### Daloy ng announce delivery

Kapag `delivery.mode = "announce"`, direktang naghahatid ang cron sa pamamagitan ng outbound channel adapters.
Hindi pinapaandar ang main agent para bumuo o mag-forward ng mensahe.

Mga detalye ng behavior:

- Nilalaman: ginagamit ng delivery ang outbound payloads (text/media) ng isolated run na may normal na chunking at channel formatting.
- Ang mga heartbeat-only na response (`HEARTBEAT_OK` na walang tunay na nilalaman) ay hindi hinahatid.
- Kung ang isolated run ay nakapagpadala na ng mensahe sa parehong target gamit ang message tool, nilalaktawan ang delivery para maiwasan ang duplicate.
- Ang kulang o invalid na delivery target ay magfa-fail sa job maliban kung `delivery.bestEffort = true`.
- Isang maikling buod ang ipo-post sa main session lamang kapag `delivery.mode = "announce"`.
- Iginagalang ng main-session summary ang `wakeMode`: ang `now` ay nagti-trigger ng agarang heartbeat at ang `next-heartbeat` ay naghihintay sa susunod na naka-iskedyul na heartbeat.

### Mga override ng model at thinking

Ang mga isolated job (`agentTurn`) ay maaaring mag-override ng model at antas ng thinking:

- `model`: Provider/model string (hal., `anthropic/claude-sonnet-4-20250514`) o alias (hal., `opus`)
- `thinking`: Antas ng thinking (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models lamang)

Tandaan: Maaari mo ring itakda ang `model` sa mga main-session job, ngunit binabago nito ang shared main session model. Inirerekomenda namin ang model overrides lamang para sa mga isolated job upang maiwasan ang hindi inaasahang pagbabago ng context.

Prayoridad ng resolusyon:

1. Job payload override (pinakamataas)
2. Hook-specific defaults (hal., `hooks.gmail.model`)
3. Agent config default

### Delivery (channel + target)

Ang mga isolated job ay maaaring maghatid ng output sa isang channel sa pamamagitan ng top-level na `delivery` config:

- `delivery.mode`: `announce` (maghatid ng buod) o `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: channel-specific na recipient target.

Ang delivery config ay valid lamang para sa mga isolated job (`sessionTarget: "isolated"`).

Kung wala ang `delivery.channel` o `delivery.to`, maaaring bumalik ang cron sa “last route” ng main session (ang huling lugar kung saan nag-reply ang agent).

Mga paalala sa format ng target:

- Ang mga target ng Slack/Discord/Mattermost (plugin) ay dapat gumamit ng explicit na prefix (hal., `channel:<id>`, `user:<id>`) upang maiwasan ang ambiguity.
- Ang mga Telegram topic ay dapat gumamit ng `:topic:` na anyo (tingnan sa ibaba).

#### Mga target ng Telegram delivery (topics / forum threads)

Sinusuportahan ng Telegram ang mga forum topic sa pamamagitan ng `message_thread_id`. Para sa cron delivery, maaari mong i-encode ang topic/thread sa `to` field:

- `-1001234567890` (chat id lamang)
- `-1001234567890:topic:123` (inirerekomenda: explicit na topic marker)
- `-1001234567890:123` (shorthand: numeric na suffix)

Tinatanggap din ang mga prefixed target tulad ng `telegram:...` / `telegram:group:...`:

- `telegram:group:-1001234567890:topic:123`

## JSON schema para sa tool calls

Gamitin ang mga hugis na ito kapag direktang tinatawag ang Gateway `cron.*` tools (agent tool calls o RPC).
Tumatanggap ang CLI flags ng mga human duration tulad ng `20m`, ngunit ang mga tool call ay dapat gumamit ng ISO 8601 string para sa `schedule.at` at milliseconds para sa `schedule.everyMs`.

### cron.add params

One-shot, main session job (system event):

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

Umuulit, isolated job na may delivery:

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

Mga tala:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), o `cron` (`expr`, opsyonal na `tz`).
- Tumatanggap ang `schedule.at` ng ISO 8601 (opsyonal ang timezone; itinuturing na UTC kapag wala).
- Ang `everyMs` ay milliseconds.
- Ang `sessionTarget` ay dapat `"main"` o `"isolated"` at dapat tumugma sa `payload.kind`.
- Mga opsyonal na field: `agentId`, `description`, `enabled`, `deleteAfterRun` (default ay true para sa `at`),
  `delivery`.
- Ang `wakeMode` ay default sa `"now"` kapag wala.

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

Mga tala:

- Ang `jobId` ang canonical; tinatanggap ang `id` para sa compatibility.
- Gamitin ang `agentId: null` sa patch para i-clear ang agent binding.

### cron.run at cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Storage & history

- Job store: `~/.openclaw/cron/jobs.json` (Gateway-managed JSON).
- Run history: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned).
- I-override ang store path: `cron.store` sa config.

## Konpigurasyon

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

I-disable ang cron nang buo:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI mabilis na pagsisimula

One-shot na paalala (UTC ISO, auto-delete pagkatapos ng tagumpay):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

One-shot na paalala (main session, gisingin kaagad):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Umuulit na isolated job (announce sa WhatsApp):

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

Umuulit na isolated job (deliver sa isang Telegram topic):

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

Isolated job na may model at thinking override:

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

Pagpili ng agent (multi-agent setup):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manwal na run (force ang default, gamitin ang `--due` para tumakbo lamang kapag due):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

I-edit ang umiiral na job (patch fields):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Run history:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Agarang system event nang hindi gumagawa ng job:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API surface

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force o due), `cron.runs`
  Para sa agarang system event nang walang job, gamitin ang [`openclaw system event`](/cli/system).

## Pag-troubleshoot

### “Walang tumatakbo”

- Suriin kung naka-enable ang cron: `cron.enabled` at `OPENCLAW_SKIP_CRON`.
- Tiyaking tuloy-tuloy na tumatakbo ang Gateway (tumatakbo ang cron sa loob ng Gateway process).
- Para sa mga schedule na `cron`: kumpirmahin ang timezone (`--tz`) kumpara sa host timezone.

### Ang umuulit na job ay patuloy na nadedelay matapos ang mga failure

- Nag-a-apply ang OpenClaw ng exponential retry backoff para sa mga umuulit na job matapos ang sunod-sunod na error:
  30s, 1m, 5m, 15m, pagkatapos ay 60m sa pagitan ng mga retry.
- Awtomatikong nagre-reset ang backoff matapos ang susunod na matagumpay na run.
- Ang mga one-shot (`at`) job ay nagdi-disable pagkatapos ng isang terminal run (`ok`, `error`, o `skipped`) at hindi na nagre-retry.

### Nagde-deliver ang Telegram sa maling lugar

- Para sa mga forum topic, gamitin ang `-100…:topic:<id>` para maging malinaw at hindi ambiguous.
- Kung makakita ka ng mga prefix na `telegram:...` sa logs o sa naka-store na “last route” targets, normal iyon;
  tinatanggap ng cron delivery ang mga iyon at tama pa ring pina-parse ang mga topic ID.
