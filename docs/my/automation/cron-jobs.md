---
summary: "Gateway scheduler အတွက် Cron jobs နှင့် wakeups"
read_when:
  - နောက်ခံအလုပ်များ သို့မဟုတ် wakeups များကို အချိန်ဇယားချထားခြင်း
  - heartbeat များနှင့်အတူ သို့မဟုတ် အတူတကွ လည်ပတ်ရမည့် automation ကို ချိတ်ဆက်ခြင်း
  - အချိန်ဇယားချထားသော အလုပ်များအတွက် heartbeat နှင့် cron ကြား ရွေးချယ်ဆုံးဖြတ်ခြင်း
title: "Cron Jobs"
---

# Cron jobs (Gateway scheduler)

> **Cron vs Heartbeat?** မည်သည့်အချိန်တွင် မည်သို့အသုံးပြုရမည်ကို လမ်းညွှန်ချက်အတွက် [Cron vs Heartbeat](/automation/cron-vs-heartbeat) ကိုကြည့်ပါ။

5. Cron သည် Gateway ၏ built-in scheduler ဖြစ်သည်။ 6. ၎င်းသည် job များကို သိမ်းဆည်းထားပြီး၊ အချိန်မှန်အောင် agent ကို နိုးထစေကာ၊ ရွေးချယ်နိုင်ပါက output ကို chat သို့ ပြန်ပို့နိုင်သည်။

_“မနက်တိုင်း အလုပ်လုပ်ပါ”_ သို့မဟုတ် _“မိနစ် ၂၀ အတွင်း agent ကို နိုးပါ”_ လိုအပ်ပါက cron ကို အသုံးပြုရပါမည်။

ပြဿနာဖြေရှင်းခြင်း: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron သည် **Gateway အတွင်း** လည်ပတ်သည် (model အတွင်းမဟုတ်ပါ)။
- Jobs များကို `~/.openclaw/cron/` အောက်တွင် သိမ်းဆည်းထားသဖြင့် restart လုပ်လျှင် အချိန်ဇယား မပျောက်ကွယ်ပါ။
- လုပ်ဆောင်ပုံစံ နှစ်မျိုးရှိသည်—
  - **Main session**: system event ကို queue ထဲသို့ ထည့်ပြီး နောက် heartbeat တွင် လည်ပတ်စေသည်။
  - **Isolated**: `cron:<jobId>` တွင် သီးသန့် agent turn ကို လည်ပတ်စေပြီး delivery (ပုံမှန်အားဖြင့် announce သို့မဟုတ် none) ပါရှိနိုင်သည်။
- Wakeups သည် ပထမတန်းစား အင်္ဂါရပ်ဖြစ်ပြီး job တစ်ခုသည် “အခုနိုးပါ” သို့မဟုတ် “နောက် heartbeat” ကို တောင်းဆိုနိုင်သည်။

## Quick start (actionable)

တစ်ကြိမ်တည်း reminder တစ်ခု ဖန်တီးပြီး ရှိနေကြောင်း အတည်ပြုပြီး ချက်ချင်း လည်ပတ်စေပါ—

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

Delivery ပါရှိသော recurring isolated job တစ်ခု အချိန်ဇယားချပါ—

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

## Tool-call equivalents (Gateway cron tool)

Canonical JSON ပုံစံများနှင့် ဥပမာများအတွက် [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls) ကိုကြည့်ပါ။

## Cron jobs များ သိမ်းဆည်းထားသည့် နေရာ

7. Cron job များကို ပုံမှန်အားဖြင့် Gateway host ရှိ `~/.openclaw/cron/jobs.json` တွင် သိမ်းဆည်းထားသည်။
8. Gateway သည် ဖိုင်ကို memory ထဲသို့ load လုပ်ပြီး ပြောင်းလဲမှုရှိပါက ပြန်ရေးသွားသောကြောင့် Gateway ကို ရပ်ထားချိန်တွင်သာ လက်ဖြင့် ပြင်ဆင်ခြင်းသည် လုံခြုံသည်။ 9. ပြောင်းလဲရန် `openclaw cron add/edit` သို့မဟုတ် cron tool call API ကို ဦးစားပေးအသုံးပြုပါ။

## Beginner-friendly overview

Cron job ကို **ဘယ်အချိန်** လည်ပတ်မည် + **ဘာလုပ်မည်** ဟု စဉ်းစားနိုင်သည်။

1. **Schedule ကို ရွေးချယ်ပါ**
   - တစ်ကြိမ်တည်း reminder → `schedule.kind = "at"` (CLI: `--at`)
   - ပြန်လည်လုပ်ဆောင်မည့် job → `schedule.kind = "every"` သို့မဟုတ် `schedule.kind = "cron"`
   - ISO timestamp တွင် timezone မပါပါက **UTC** ဟု သတ်မှတ်ပါသည်။

2. **ဘယ်နေရာတွင် လည်ပတ်မည်ကို ရွေးပါ**
   - `sessionTarget: "main"` → နောက် heartbeat တွင် main context ဖြင့် လည်ပတ်မည်။
   - `sessionTarget: "isolated"` → `cron:<jobId>` တွင် သီးသန့် agent turn ကို လည်ပတ်မည်။

3. **Payload ကို ရွေးပါ**
   - Main session → `payload.kind = "systemEvent"`
   - Isolated session → `payload.kind = "agentTurn"`

10) ရွေးချယ်စရာ: one-shot job များ (`schedule.kind = "at"`) သည် အောင်မြင်ပြီးနောက် ပုံမှန်အားဖြင့် အလိုအလျောက် ဖျက်ပစ်သည်။ 11. ၎င်းတို့ကို ဆက်လက်ထားလိုပါက `deleteAfterRun: false` ကို သတ်မှတ်ပါ (အောင်မြင်ပြီးနောက် disable ဖြစ်သွားမည်)။

## Concepts

### Jobs

Cron job တစ်ခုတွင် အောက်ပါအချက်များ ပါဝင်သည်—

- **schedule** (ဘယ်အချိန် လည်ပတ်မည်),
- **payload** (ဘာလုပ်မည်),
- ရွေးချယ်နိုင်သော **delivery mode** (announce သို့မဟုတ် none)။
- ရွေးချယ်နိုင်သော **agent binding** (`agentId`): သတ်မှတ်ထားသော agent ဖြင့် လည်ပတ်စေခြင်း; မရှိပါက သို့မဟုတ် မသိပါက Gateway သည် default agent သို့ ပြန်လည်ရွေးချယ်ပါသည်။

12. Job များကို တည်ငြိမ်သော `jobId` ဖြင့် သတ်မှတ်ထားသည် (CLI/Gateway API များတွင် အသုံးပြုသည်)။
    In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.
13. One-shot job များသည် အောင်မြင်ပြီးနောက် ပုံမှန်အားဖြင့် အလိုအလျောက် ဖျက်ပစ်သည်။ ဆက်လက်ထားလိုပါက `deleteAfterRun: false` ကို သတ်မှတ်ပါ။

### Schedules

Cron သည် schedule အမျိုးအစား သုံးမျိုးကို ပံ့ပိုးပါသည်—

- `at`: `schedule.at` (ISO 8601) ဖြင့် သတ်မှတ်သော တစ်ကြိမ်တည်း timestamp။
- `every`: သတ်မှတ်ထားသော interval (ms)။
- `cron`: IANA timezone ရွေးချယ်နိုင်သော 5-field cron expression။

15. Cron expression များသည် `croner` ကို အသုံးပြုသည်။ If a timezone is omitted, the Gateway host’s
    local timezone is used.

### Main vs isolated execution

#### Main session jobs (system events)

17. Main job များသည် system event တစ်ခုကို enqueue လုပ်ပြီး ရွေးချယ်နိုင်ပါက heartbeat runner ကို နိုးထစေသည်။
18. ၎င်းတို့သည် `payload.kind = "systemEvent"` ကို အသုံးပြုရမည်။

- `wakeMode: "now"` (default): event သည် ချက်ချင်း heartbeat ကို လည်ပတ်စေသည်။
- `wakeMode: "next-heartbeat"`: event သည် နောက် scheduled heartbeat ကို စောင့်ဆိုင်းသည်။

19. သာမန် heartbeat prompt + main-session context ကို လိုချင်သောအခါ ဤနည်းလမ်းသည် အကောင်းဆုံး ကိုက်ညီသည်။
    See [Heartbeat](/gateway/heartbeat).

#### Isolated jobs (dedicated cron sessions)

Isolated jobs များသည် session `cron:<jobId>` တွင် သီးသန့် agent turn ကို လည်ပတ်စေပါသည်။

အရေးကြီးသော အပြုအမူများ—

- Traceability အတွက် prompt ကို `[cron:<jobId> <job name>]` ဖြင့် အစပြုပါသည်။
- လည်ပတ်မှုတိုင်းသည် **session id အသစ်** ဖြင့် စတင်ပါသည် (ယခင် စကားဝိုင်း မပါဝင်ပါ)။
- ပုံမှန်အပြုအမူ—`delivery` မသတ်မှတ်ထားပါက isolated jobs များသည် အကျဉ်းချုပ်ကို announce လုပ်ပါသည် (`delivery.mode = "announce"`)။
- `delivery.mode` (isolated-only) သည် အပြုအမူကို ရွေးချယ်ပါသည်—
  - `announce`: target channel သို့ အကျဉ်းချုပ် ပို့ပြီး main session သို့ အတိုချုပ် တင်ပါသည်။
  - `none`: internal only (delivery မရှိ၊ main-session summary မရှိ)။
- `wakeMode` သည် main-session summary တင်သည့် အချိန်ကို ထိန်းချုပ်ပါသည်—
  - `now`: ချက်ချင်း heartbeat။
  - `next-heartbeat`: နောက် scheduled heartbeat ကို စောင့်ဆိုင်းသည်။

Noise များသော၊ မကြာခဏ ဖြစ်ပေါ်သော၊ သို့မဟုတ် “နောက်ခံအလုပ်များ” အတွက် isolated jobs ကို အသုံးပြုပါ၊ main chat history ကို မစွပ်စွဲစေရန်။

### Payload shapes (what runs)

Payload အမျိုးအစား နှစ်မျိုးကို ပံ့ပိုးပါသည်—

- `systemEvent`: main-session only, heartbeat prompt မှတဆင့် route လုပ်သည်။
- `agentTurn`: isolated-session only, သီးသန့် agent turn ကို လည်ပတ်စေသည်။

ပုံမှန် `agentTurn` fields—

- `message`: မဖြစ်မနေ လိုအပ်သော text prompt။
- `model` / `thinking`: ရွေးချယ်နိုင်သော override များ (အောက်တွင် ကြည့်ပါ)။
- `timeoutSeconds`: ရွေးချယ်နိုင်သော timeout override။

Delivery config (isolated jobs only)—

- `delivery.mode`: `none` | `announce`။
- `delivery.channel`: `last` သို့မဟုတ် သီးသန့် channel တစ်ခု။
- `delivery.to`: channel-specific target (ဖုန်း/ချက်/ချန်နယ် id)။
- `delivery.bestEffort`: announce delivery မအောင်မြင်ပါက job ကို မဖျက်သိမ်းရန်။

21. Announce delivery သည် run အတွင်း messaging tool send များကို ဖိနှိပ်ထားသည်။ Chat ကို ရည်ညွှန်းရန် `delivery.channel`/`delivery.to` ကို အသုံးပြုပါ။ 22. `delivery.mode = "none"` ဖြစ်ပါက main session သို့ summary ကို မတင်ပါ။

Isolated jobs များအတွက် `delivery` မသတ်မှတ်ထားပါက OpenClaw သည် ပုံမှန်အားဖြင့် `announce` ကို အသုံးပြုပါသည်။

#### Announce delivery flow

When `delivery.mode = "announce"`, cron delivers directly via the outbound channel adapters.
24. စာကို ဖန်တီးခြင်း သို့မဟုတ် လွှဲပြောင်းပို့ခြင်းအတွက် main agent ကို မဖွင့်ပေးပါ။

အပြုအမူ အသေးစိတ်—

- Content: isolated run ၏ outbound payloads (text/media) ကို ပုံမှန် chunking နှင့် channel formatting ဖြင့် ပို့ဆောင်ပါသည်။
- Heartbeat-only responses (`HEARTBEAT_OK` သာပါပြီး အမှန်တကယ် content မပါပါက) ကို မပို့ဆောင်ပါ။
- Isolated run က message tool ဖြင့် တူညီသော target သို့ မက်ဆေ့ချ် ပို့ပြီးသားဖြစ်ပါက duplicate မဖြစ်စေရန် delivery ကို ကျော်လွှားပါသည်။
- Delivery target မရှိခြင်း သို့မဟုတ် မမှန်ကန်ပါက `delivery.bestEffort = true` မရှိလျှင် job ကို fail လုပ်ပါသည်။
- `delivery.mode = "announce"` ဖြစ်သည့်အခါမှသာ main session သို့ အတိုချုပ် တင်ပါသည်။
- Main-session summary သည် `wakeMode` ကို လေးစားပါသည်—`now` သည် ချက်ချင်း heartbeat ကို ဖြစ်စေပြီး `next-heartbeat` သည် နောက် scheduled heartbeat ကို စောင့်ပါသည်။

### Model နှင့် thinking overrides

Isolated jobs (`agentTurn`) များသည် model နှင့် thinking level ကို override လုပ်နိုင်ပါသည်—

- `model`: Provider/model string (ဥပမာ `anthropic/claude-sonnet-4-20250514`) သို့မဟုတ် alias (ဥပမာ `opus`)
- `thinking`: Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models များသာ)

25. မှတ်ချက်: main-session job များတွင်လည်း `model` ကို သတ်မှတ်နိုင်သော်လည်း shared main session model ကို ပြောင်းလဲသွားစေသည်။ 26. မမျှော်လင့်သော context ပြောင်းလဲမှုများကို ရှောင်ရှားရန် isolated job များအတွက်သာ model override များကို အကြံပြုပါသည်။

Resolution priority—

1. Job payload override (အမြင့်ဆုံး)
2. Hook-specific defaults (ဥပမာ `hooks.gmail.model`)
3. Agent config default

### Delivery (channel + target)

Isolated jobs များသည် အပေါ်ဆုံး `delivery` config မှတဆင့် channel သို့ output ပို့ဆောင်နိုင်ပါသည်—

- `delivery.mode`: `announce` (အကျဉ်းချုပ် ပို့ဆောင်) သို့မဟုတ် `none`။
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`။
- `delivery.to`: channel-specific recipient target။

Delivery config သည် isolated jobs များအတွက်သာ အသုံးပြုနိုင်ပါသည် (`sessionTarget: "isolated"`)။

`delivery.channel` သို့မဟုတ် `delivery.to` မသတ်မှတ်ထားပါက cron သည် main session ၏ “last route” (agent နောက်ဆုံး ပြန်ကြားခဲ့သည့် နေရာ) ကို အသုံးပြုနိုင်ပါသည်။

Target format သတိပေးချက်များ—

- Slack/Discord/Mattermost (plugin) targets များတွင် မရှုပ်ထွေးစေရန် `channel:<id>`, `user:<id>` ကဲ့သို့သော explicit prefixes ကို အသုံးပြုပါ။
- Telegram topics များတွင် `:topic:` ပုံစံကို အသုံးပြုပါ (အောက်တွင် ကြည့်ပါ)။

#### Telegram delivery targets (topics / forum threads)

27. Telegram သည် `message_thread_id` ဖြင့် forum topic များကို ထောက်ပံ့သည်။ 28. Cron delivery အတွက် topic/thread ကို `to` field ထဲတွင် encode လုပ်နိုင်သည်။

- `-1001234567890` (chat id သာ)
- `-1001234567890:topic:123` (အကြံပြု: explicit topic marker)
- `-1001234567890:123` (shorthand: numeric suffix)

`telegram:...` / `telegram:group:...` ကဲ့သို့သော prefixed targets များကိုလည်း လက်ခံပါသည်—

- `telegram:group:-1001234567890:topic:123`

## JSON schema for tool calls

29. Gateway `cron.*` tool များကို တိုက်ရိုက်ခေါ်သောအခါ (agent tool call သို့မဟုတ် RPC) ဤ shape များကို အသုံးပြုပါ။
30. CLI flag များသည် `20m` ကဲ့သို့ လူသားနားလည်လွယ်သော duration များကို လက်ခံသော်လည်း tool call များတွင် `schedule.at` အတွက် ISO 8601 string နှင့် `schedule.everyMs` အတွက် milliseconds ကို အသုံးပြုရမည်။

### cron.add params

တစ်ကြိမ်တည်း၊ main session job (system event)—

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

Delivery ပါရှိသော recurring, isolated job—

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

မှတ်ချက်များ—

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), သို့မဟုတ် `cron` (`expr`, ရွေးချယ်နိုင်သော `tz`)။
- `schedule.at` သည် ISO 8601 ကို လက်ခံပါသည် (timezone ရွေးချယ်နိုင်; မပါပါက UTC ဟု သတ်မှတ်ပါသည်)။
- `everyMs` သည် milliseconds ဖြစ်ပါသည်။
- `sessionTarget` သည် `"main"` သို့မဟုတ် `"isolated"` ဖြစ်ရမည်ဖြစ်ပြီး `payload.kind` နှင့် ကိုက်ညီရပါမည်။
- ရွေးချယ်နိုင်သော fields: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at` အတွက် default true),
  `delivery`။
- `wakeMode` ကို မသတ်မှတ်ပါက `"now"` ကို default အဖြစ် အသုံးပြုပါသည်။

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

မှတ်ချက်များ—

- `jobId` သည် canonical ဖြစ်ပြီး `id` ကို compatibility အတွက် လက်ခံပါသည်။
- Agent binding ကို ဖယ်ရှားရန် patch ထဲတွင် `agentId: null` ကို အသုံးပြုပါ။

### cron.run နှင့် cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Storage & history

- Job store: `~/.openclaw/cron/jobs.json` (Gateway-managed JSON)။
- Run history: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned)။
- Store path ကို override လုပ်ရန်: config ထဲရှိ `cron.store`။

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Cron ကို လုံးဝ ပိတ်ရန်—

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI quickstart

တစ်ကြိမ်တည်း reminder (UTC ISO, အောင်မြင်ပြီးနောက် auto-delete)—

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

တစ်ကြိမ်တည်း reminder (main session, ချက်ချင်း နိုး)—

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job (WhatsApp သို့ announce)—

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

Recurring isolated job (Telegram topic သို့ ပို့ဆောင်)—

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

Model နှင့် thinking override ပါရှိသော isolated job—

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

Agent ရွေးချယ်မှု (multi-agent setups)—

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manual run (force သည် default ဖြစ်ပြီး due ဖြစ်သည့်အခါသာ လည်ပတ်စေရန် `--due` ကို အသုံးပြုပါ)—

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

ရှိပြီးသား job ကို ပြင်ဆင်ရန် (patch fields)—

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Run history—

```bash
openclaw cron runs --id <jobId> --limit 50
```

Job မဖန်တီးဘဲ ချက်ချင်း system event—

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API surface

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force သို့မဟုတ် due), `cron.runs`
  Job မပါဘဲ ချက်ချင်း system events အတွက် [`openclaw system event`](/cli/system) ကို အသုံးပြုပါ။

## Troubleshooting

### “ဘာမှ မလည်ပတ်ပါ”

- Cron ဖွင့်ထားခြင်း ရှိမရှိ စစ်ဆေးပါ—`cron.enabled` နှင့် `OPENCLAW_SKIP_CRON`။
- Gateway သည် အမြဲတမ်း လည်ပတ်နေကြောင်း စစ်ဆေးပါ (cron သည် Gateway process အတွင်း လည်ပတ်သည်)။
- `cron` schedules များအတွက် timezone (`--tz`) နှင့် host timezone ကို အတည်ပြုပါ။

### Recurring job တစ်ခုသည် မအောင်မြင်မှုများနောက်တွင် ဆက်လက် နောက်ကျနေပါသည်

- OpenClaw သည် ဆက်တိုက် error များဖြစ်ပါက recurring jobs များအတွက် exponential retry backoff ကို အသုံးပြုပါသည်—
  30s, 1m, 5m, 15m, ထို့နောက် retry တစ်ခုချင်းအကြား 60m။
- နောက်တစ်ကြိမ် အောင်မြင်သော run ဖြစ်ပြီးနောက် backoff သည် အလိုအလျောက် reset ဖြစ်ပါသည်။
- တစ်ကြိမ်တည်း (`at`) jobs များသည် terminal run (`ok`, `error`, သို့မဟုတ် `skipped`) အပြီးတွင် disable ဖြစ်ပြီး retry မလုပ်ပါ။

### Telegram သည် မှားသော နေရာသို့ ပို့နေပါသည်

- Forum topics အတွက် `-100…:topic:<id>` ကို အသုံးပြုပါ၊ ထင်ရှားပြီး မရှုပ်ထွေးစေရန်။
- Logs သို့မဟုတ် သိမ်းဆည်းထားသော “last route” targets များတွင် `telegram:...` prefixes ကို မြင်တွေ့ပါက ပုံမှန်ဖြစ်ပါသည်;
  cron delivery သည် ၎င်းတို့ကို လက်ခံပြီး topic IDs များကို မှန်ကန်စွာ parse လုပ်နိုင်ပါသည်။
