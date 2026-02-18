---
summary: "လော့ဂ်များ၏ အကျဉ်းချုပ် – ဖိုင်လော့ဂ်များ၊ ကွန်ဆိုလ်ထုတ်လွှင့်မှု၊ CLI ဖြင့် tail ကြည့်ခြင်း၊ Control UI"
read_when:
  - လော့ဂ်စနစ်ကို စတင်နားလည်ရန် လွယ်ကူသော အကျဉ်းချုပ်လိုအပ်သောအခါ
  - လော့ဂ်အဆင့်များ သို့မဟုတ် ဖော်မတ်များကို ဖွဲ့စည်းပြင်ဆင်လိုသည့်အခါ
  - ပြဿနာဖြေရှင်းနေစဉ် လော့ဂ်များကို လျင်မြန်စွာ ရှာဖွေရန် လိုအပ်သောအခါ
title: "Logging"
---

# Logging

OpenClaw သည် နေရာနှစ်ခုတွင် လော့ဂ်များကို မှတ်တမ်းတင်ထားသည်–

- **ဖိုင်လော့ဂ်များ** (JSON lines) ကို Gateway မှ ရေးသားထားသည်။
- **ကွန်ဆိုလ်ထုတ်လွှင့်မှု** ကို terminal များနှင့် Control UI တွင် ပြသထားသည်။

ဤစာမျက်နှာတွင် လော့ဂ်များရှိရာနေရာ၊ ဖတ်ရှုနည်း၊ နှင့် လော့ဂ်အဆင့်များ၊ ဖော်မတ်များကို မည်သို့ ဖွဲ့စည်းပြင်ဆင်ရမည်ကို ရှင်းပြထားသည်။

## လော့ဂ်များရှိရာနေရာ

ပုံမှန်အားဖြင့် Gateway သည် လှည့်ပတ်ရေးသားသော လော့ဂ်ဖိုင်ကို အောက်ပါနေရာတွင် ရေးသားသည်–

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

နေ့စွဲသည် gateway host ၏ ဒေသခံ အချိန်ဇုန်ကို အသုံးပြုထားသည်။

`~/.openclaw/openclaw.json` တွင် ဤတန်ဖိုးကို ပြောင်းလဲနိုင်သည်–

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## လော့ဂ်များကို ဖတ်ရှုနည်း

### CLI: live tail (အကြံပြု)

CLI ကို အသုံးပြု၍ RPC မှတစ်ဆင့် gateway လော့ဂ်ဖိုင်ကို tail ကြည့်ပါ–

```bash
openclaw logs --follow
```

Output မုဒ်များ–

- **TTY sessions**: လှပစွာ ဖော်ပြထားသော၊ အရောင်ပါသော၊ ဖွဲ့စည်းထားသည့် လော့ဂ်လိုင်းများ။
- **Non-TTY sessions**: စာသားသာဖြစ်သော output။
- `--json`: လိုင်းအလိုက် JSON (လော့ဂ်ဖြစ်ရပ် တစ်ခုလျှင် တစ်လိုင်း)။
- `--plain`: TTY sessions တွင် စာသားသာ အတင်းအကျပ် အသုံးပြုရန်။
- `--no-color`: ANSI အရောင်များကို ပိတ်ရန်။

JSON မုဒ်တွင် CLI သည် `type` tag ပါသော object များကို ထုတ်ပေးသည်–

- `meta`: stream metadata (ဖိုင်၊ cursor၊ အရွယ်အစား)
- `log`: ခွဲခြမ်းစိတ်ဖြာထားသော လော့ဂ် entry
- `notice`: ဖြတ်တောက်ခြင်း / လှည့်ပြောင်းရေးသားခြင်း အညွှန်းများ
- `raw`: မခွဲခြမ်းစိတ်ဖြာရသေးသော လော့ဂ်လိုင်း

Gateway ကို မရောက်ရှိနိုင်ပါက CLI သည် အောက်ပါအမိန့်ကို run လုပ်ရန် အကျဉ်းချုပ် အညွှန်းကို ပြသမည်–

```bash
openclaw doctor
```

### Control UI (web)

Control UI ၏ **Logs** tab သည် `logs.tail` ကို အသုံးပြု၍ တူညီသော ဖိုင်ကို tail လုပ်ပါသည်။
ဖွင့်ရန် နည်းလမ်းအတွက် [/web/control-ui](/web/control-ui) ကို ကြည့်ပါ။

### Channel သီးသန့် လော့ဂ်များ

Channel လှုပ်ရှားမှုများ (WhatsApp/Telegram/အခြား) ကို စစ်ထုတ်ရန်–

```bash
openclaw channels logs --channel whatsapp
```

## လော့ဂ်ဖော်မတ်များ

### ဖိုင်လော့ဂ်များ (JSONL)

log ဖိုင်အတွင်းရှိ line တစ်ကြောင်းစီသည် JSON object တစ်ခုဖြစ်ပါသည်။ CLI နှင့် Control UI သည် ဤ entries များကို parse လုပ်၍ structured output (အချိန်၊ level၊ subsystem၊ message) အဖြစ် ပြသပါသည်။

### ကွန်ဆိုလ်ထုတ်လွှင့်မှု

ကွန်ဆိုလ်လော့ဂ်များသည် **TTY-aware** ဖြစ်ပြီး ဖတ်ရလွယ်ကူအောင် ဖော်မတ်ထားသည်–

- Subsystem prefix များ (ဥပမာ– `gateway/channels/whatsapp`)
- အဆင့်အလိုက် အရောင် (info/warn/error)
- compact သို့မဟုတ် JSON မုဒ် (ရွေးချယ်နိုင်)

ကွန်ဆိုလ်ဖော်မတ်ကို `logging.consoleStyle` ဖြင့် ထိန်းချုပ်သည်။

## Logging ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

Logging ဆိုင်ရာ ဖွဲ့စည်းပြင်ဆင်မှုအားလုံးသည် `~/.openclaw/openclaw.json` အတွင်းရှိ `logging` အောက်တွင် တည်ရှိသည်။

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### လော့ဂ်အဆင့်များ

- `logging.level`: **ဖိုင်လော့ဂ်များ** (JSONL) အတွက် အဆင့်။
- `logging.consoleLevel`: **ကွန်ဆိုလ်** အတွက် အသေးစိတ်အဆင့်။

`--verbose` သည် ကွန်ဆိုလ်ထုတ်လွှင့်မှုကိုသာ သက်ရောက်ပြီး ဖိုင်လော့ဂ်အဆင့်များကို မပြောင်းလဲပါ။

### ကွန်ဆိုလ်စတိုင်များ

`logging.consoleStyle`–

- `pretty`: လူဖတ်ရလွယ်ကူ၊ အရောင်ပါ၊ timestamp ပါ။
- `compact`: အထွေထွေထုတ်လွှင့်မှုနည်း (ရှည်လျားသော session များအတွက် အကောင်းဆုံး)။
- `json`: လိုင်းအလိုက် JSON (log processor များအတွက်)။

### Redaction

Tool summary များတွင် အရေးကြီး token များကို ကွန်ဆိုလ်သို့ မရောက်မီ ဖျောက်ထားနိုင်သည်–

- `logging.redactSensitive`: `off` | `tools` (ပုံမှန်– `tools`)
- `logging.redactPatterns`: မူရင်း set ကို အစားထိုးရန် regex string စာရင်း

Redaction သည် **ကွန်ဆိုလ်ထုတ်လွှင့်မှုသာ** သက်ရောက်ပြီး ဖိုင်လော့ဂ်များကို မပြောင်းလဲပါ။

## Diagnostics + OpenTelemetry

Diagnostics များသည် model run များအတွက် **နှင့်** message-flow telemetry (webhooks၊ queueing၊ session state) အတွက် စနစ်တကျ ဖွဲ့စည်းထားသော၊ စက်ဖြင့်ဖတ်နိုင်သော event များဖြစ်ပါသည်။ ၎င်းတို့သည် logs ကို အစားထိုးခြင်း မဟုတ်ပါ၊ metrics၊ traces နှင့် အခြား exporter များကို ပံ့ပိုးရန် ရည်ရွယ်ပါသည်။

Diagnostics ဖြစ်ရပ်များကို process အတွင်း ထုတ်ပေးသော်လည်း diagnostics နှင့် exporter plugin ကို ဖွင့်ထားမှသာ exporter များက ချိတ်ဆက်မည်ဖြစ်သည်။

### OpenTelemetry နှင့် OTLP

- **OpenTelemetry (OTel)**: traces၊ metrics၊ logs အတွက် data model နှင့် SDK များ။
- **OTLP**: OTel data ကို collector/backend သို့ ပို့ရန် အသုံးပြုသော wire protocol။
- OpenClaw သည် လက်ရှိတွင် **OTLP/HTTP (protobuf)** ဖြင့် export လုပ်သည်။

### Export လုပ်သော signal များ

- **Metrics**: counters + histograms (token အသုံးပြုမှု၊ message flow၊ queueing)။
- **Traces**: မော်ဒယ်အသုံးပြုမှု နှင့် webhook/message processing အတွက် spans။
- **Logs**: `diagnostics.otel.logs` ကို ဖွင့်ထားပါက OTLP မှတစ်ဆင့် export လုပ်ပါသည်။ log အရေအတွက်သည် များနိုင်ပါသည်; `logging.level` နှင့် exporter filter များကို ထည့်သွင်းစဉ်းစားပါ။

### Diagnostic event catalog

Model usage–

- `model.usage`: tokens၊ cost၊ duration၊ context၊ provider/model/channel၊ session ids။

Message flow–

- `webhook.received`: channel အလိုက် webhook ingress။
- `webhook.processed`: webhook ကို ကိုင်တွယ်ပြီးချိန် + ကြာချိန်။
- `webhook.error`: webhook handler အမှားများ။
- `message.queued`: message ကို processing အတွက် queue ထဲသို့ ထည့်ခြင်း။
- `message.processed`: ရလဒ် + ကြာချိန် + ရွေးချယ်နိုင်သော အမှား။

Queue + session–

- `queue.lane.enqueue`: command queue lane enqueue + အနက်။
- `queue.lane.dequeue`: command queue lane dequeue + စောင့်ဆိုင်းချိန်။
- `session.state`: session state ပြောင်းလဲမှု + အကြောင်းရင်း။
- `session.stuck`: session ပိတ်မိနေမှု သတိပေးချက် + အသက်အရွယ်။
- `run.attempt`: run retry/attempt metadata။
- `diagnostic.heartbeat`: စုစုပေါင်း counter များ (webhooks/queue/session)။

### Diagnostics ကို ဖွင့်ခြင်း (exporter မပါ)

Plugin များ သို့မဟုတ် custom sink များအတွက် diagnostics ဖြစ်ရပ်များကို အသုံးပြုလိုပါက–

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Diagnostics flags (ရည်ရွယ်ချက်ရှိသော လော့ဂ်များ)

`logging.level` ကို မမြှင့်ဘဲ အထူးသီးသန့် debug logs များကို ဖွင့်ရန် flags များကို အသုံးပြုပါ။
Flags များသည် case-insensitive ဖြစ်ပြီး wildcard များကို ထောက်ပံ့ပါသည် (ဥပမာ `telegram.*` သို့မဟုတ် `*`)။

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env override (တစ်ကြိမ်သာ)–

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

မှတ်ချက်များ–

- Flag လော့ဂ်များသည် ပုံမှန် လော့ဂ်ဖိုင် ( `logging.file` နှင့် တူညီ) သို့ ရောက်ရှိသည်။
- Output သည် `logging.redactSensitive` အတိုင်း redaction လုပ်ထားဆဲ ဖြစ်သည်။
- လမ်းညွှန်အပြည့်အစုံ– [/diagnostics/flags](/diagnostics/flags)။

### OpenTelemetry သို့ export လုပ်ခြင်း

Diagnostics များကို `diagnostics-otel` plugin (OTLP/HTTP) ဖြင့် export လုပ်နိုင်ပါသည်။ ဤသည်သည် OTLP/HTTP ကို လက်ခံသော OpenTelemetry collector/backend မည်သည့်အမျိုးအစားမဆို အသုံးပြုနိုင်ပါသည်။

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

မှတ်ချက်များ–

- `openclaw plugins enable diagnostics-otel` ဖြင့်လည်း plugin ကို ဖွင့်နိုင်သည်။
- `protocol` သည် လက်ရှိအချိန်တွင် `http/protobuf` ကိုသာ ထောက်ပံ့ပါသည်။ `grpc` ကို လျစ်လျူရှုပါသည်။
- Metrics တွင် token အသုံးပြုမှု၊ cost၊ context အရွယ်အစား၊ run ကြာချိန်၊ နှင့် message-flow counter/histogram များ (webhooks, queueing, session state, queue depth/wait) ပါဝင်သည်။
- Traces/metrics များကို `traces` / `metrics` ဖြင့် toggle လုပ်နိုင်ပါသည် (default: on)။ Traces
  မှာ enable လုပ်ထားရင် model usage spans နဲ့ webhook/message processing spans တွေ ပါဝင်ပါတယ်။
- Collector တွင် auth လိုအပ်ပါက `headers` ကို သတ်မှတ်ပါ။
- ထောက်ပံ့သော environment variables– `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`။

### Export လုပ်ထားသော metrics (အမည် + အမျိုးအစား)

Model usage–

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Message flow–

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Queues + sessions–

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` သို့မဟုတ်
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Export လုပ်ထားသော spans (အမည် + အဓိက attribute များ)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Sampling + flushing

- Trace sampling– `diagnostics.otel.sampleRate` (0.0–1.0, root span များသာ)။
- Metric export interval– `diagnostics.otel.flushIntervalMs` (အနည်းဆုံး 1000ms)။

### Protocol မှတ်ချက်များ

- OTLP/HTTP endpoint များကို `diagnostics.otel.endpoint` သို့မဟုတ်
  `OTEL_EXPORTER_OTLP_ENDPOINT` ဖြင့် သတ်မှတ်နိုင်သည်။
- Endpoint တွင် `/v1/traces` သို့မဟုတ် `/v1/metrics` ပါရှိပြီးသားဖြစ်ပါက ထိုအတိုင်း အသုံးပြုမည်။
- Endpoint တွင် `/v1/logs` ပါရှိပြီးသားဖြစ်ပါက logs အတွက် ထိုအတိုင်း အသုံးပြုမည်။
- `diagnostics.otel.logs` သည် အဓိက logger output အတွက် OTLP log export ကို ဖွင့်ပေးသည်။

### Log export အပြုအမူ

- OTLP လော့ဂ်များသည် `logging.file` သို့ ရေးသားသော ဖွဲ့စည်းထားသည့် record များနှင့် တူညီသည်။
- `logging.level` (file log level) ကို လိုက်နာပါ။ Console redaction သည် OTLP logs များတွင် **မသက်ရောက်ပါ**။
- လော့ဂ်အရေအတွက်များသော install များတွင် OTLP collector sampling/filtering ကို ဦးစားပေးသင့်သည်။

## ပြဿနာဖြေရှင်းရန် အကြံပြုချက်များ

- **Gateway မရောက်ရှိနိုင်ပါသလား?** အရင်ဆုံး `openclaw doctor` ကို run လုပ်ပါ။
- **လော့ဂ်များ မရှိဘူးလား?** Gateway သည် လည်ပတ်နေပြီး `logging.file` တွင် သတ်မှတ်ထားသော ဖိုင်လမ်းကြောင်းသို့ ရေးသားနေသည်ကို စစ်ဆေးပါ။
- **အသေးစိတ်ပိုလိုအပ်ပါသလား?** `logging.level` ကို `debug` သို့မဟုတ် `trace` သို့ သတ်မှတ်ပြီး ထပ်မံကြိုးစားပါ။
