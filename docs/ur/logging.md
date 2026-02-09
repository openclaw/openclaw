---
summary: "لاگنگ کا جائزہ: فائل لاگز، کنسول آؤٹ پٹ، CLI ٹیلنگ، اور کنٹرول UI"
read_when:
  - آپ کو لاگنگ کا مبتدی دوست جائزہ درکار ہو
  - آپ لاگ لیولز یا فارمیٹس کنفیگر کرنا چاہتے ہوں
  - آپ خرابیوں کا ازالہ کر رہے ہوں اور لاگز تیزی سے تلاش کرنا چاہتے ہوں
title: "لاگنگ"
---

# لاگنگ

OpenClaw دو جگہوں پر لاگز لکھتا ہے:

- **فائل لاگز** (JSON لائنیں) جو Gateway کے ذریعے لکھی جاتی ہیں۔
- **کنسول آؤٹ پٹ** جو ٹرمینلز اور کنٹرول UI میں دکھائی جاتی ہے۔

یہ صفحہ بتاتا ہے کہ لاگز کہاں ہوتے ہیں، انہیں کیسے پڑھا جائے، اور لاگ
لیولز اور فارمیٹس کیسے کنفیگر کیے جائیں۔

## لاگز کہاں ہوتے ہیں

بطورِ طے شدہ، Gateway درج ذیل راستے کے تحت ایک رولنگ لاگ فائل لکھتا ہے:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

تاریخ gateway host کے مقامی ٹائم زون کے مطابق ہوتی ہے۔

آپ اسے `~/.openclaw/openclaw.json` میں اووررائیڈ کر سکتے ہیں:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## لاگز کیسے پڑھیں

### CLI: لائیو ٹیل (سفارش کردہ)

RPC کے ذریعے gateway لاگ فائل کو ٹیل کرنے کے لیے CLI استعمال کریں:

```bash
openclaw logs --follow
```

آؤٹ پٹ موڈز:

- **TTY سیشنز**: خوبصورت، رنگین، ساختہ لاگ لائنیں۔
- **Non-TTY سیشنز**: سادہ متن۔
- `--json`: لائن-ڈیلیمیٹڈ JSON (ہر لائن پر ایک لاگ ایونٹ)۔
- `--plain`: TTY سیشنز میں سادہ متن پر مجبور کریں۔
- `--no-color`: ANSI رنگ غیر فعال کریں۔

JSON موڈ میں، CLI `type`-ٹیگ شدہ آبجیکٹس خارج کرتا ہے:

- `meta`: اسٹریم میٹاڈیٹا (فائل، کرسر، سائز)
- `log`: پارس شدہ لاگ اندراج
- `notice`: کٹاؤ / روٹیشن اشارے
- `raw`: غیر پارس شدہ لاگ لائن

اگر Gateway ناقابلِ رسائی ہو، تو CLI یہ چلانے کا ایک مختصر اشارہ پرنٹ کرتا ہے:

```bash
openclaw doctor
```

### کنٹرول UI (ویب)

Control UI کا **Logs** ٹیب `logs.tail` استعمال کرتے ہوئے اسی فائل کو ٹیل کرتا ہے۔
اسے کھولنے کا طریقہ دیکھنے کے لیے [/web/control-ui](/web/control-ui) دیکھیں۔

### چینل-صرف لاگز

چینل سرگرمی (WhatsApp/Telegram وغیرہ) فلٹر کرنے کے لیے استعمال کریں:

```bash
openclaw channels logs --channel whatsapp
```

## لاگ فارمیٹس

### فائل لاگز (JSONL)

لاگ فائل کی ہر لائن ایک JSON آبجیکٹ ہوتی ہے۔ The CLI and Control UI parse these
entries to render structured output (time, level, subsystem, message).

### کنسول آؤٹ پٹ

کنسول لاگز **TTY-aware** ہوتے ہیں اور پڑھنے میں آسانی کے لیے فارمیٹ کیے جاتے ہیں:

- سب سسٹم پری فکسز (مثلاً `gateway/channels/whatsapp`)
- لیول کے مطابق رنگ (info/warn/error)
- اختیاری کمپیکٹ یا JSON موڈ

کنسول فارمیٹنگ `logging.consoleStyle` کے ذریعے کنٹرول ہوتی ہے۔

## لاگنگ کی کنفیگریشن

تمام لاگنگ کنفیگریشن `~/.openclaw/openclaw.json` میں `logging` کے تحت ہوتی ہے۔

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

### لاگ لیولز

- `logging.level`: **فائل لاگز** (JSONL) کا لیول۔
- `logging.consoleLevel`: **کنسول** کی verbosity لیول۔

`--verbose` صرف کنسول آؤٹ پٹ کو متاثر کرتا ہے؛ یہ فائل لاگ لیولز کو تبدیل نہیں کرتا۔

### کنسول اسٹائلز

`logging.consoleStyle`:

- `pretty`: انسان دوست، رنگین، ٹائم اسٹیمپس کے ساتھ۔
- `compact`: زیادہ مختصر آؤٹ پٹ (طویل سیشنز کے لیے بہترین)۔
- `json`: فی لائن JSON (لاگ پروسیسرز کے لیے)۔

### ریڈیکشن

ٹول سمریز کنسول تک پہنچنے سے پہلے حساس ٹوکنز کو ریڈیکٹ کر سکتی ہیں:

- `logging.redactSensitive`: `off` | `tools` (بطورِ طے شدہ: `tools`)
- `logging.redactPatterns`: ڈیفالٹ سیٹ کو اووررائیڈ کرنے کے لیے regex اسٹرنگز کی فہرست

ریڈیکشن **صرف کنسول آؤٹ پٹ** کو متاثر کرتی ہے اور فائل لاگز کو تبدیل نہیں کرتی۔

## تشخیصی معلومات + OpenTelemetry

Diagnostics are structured, machine-readable events for model runs **and**
message-flow telemetry (webhooks, queueing, session state). They do **not**
replace logs; they exist to feed metrics, traces, and other exporters.

تشخیصی ایونٹس اِن-پروسیس خارج ہوتے ہیں، لیکن ایکسپورٹرز صرف تب منسلک ہوتے ہیں
جب diagnostics اور ایکسپورٹر پلگ اِن فعال ہوں۔

### OpenTelemetry بمقابلہ OTLP

- **OpenTelemetry (OTel)**: ٹریسز، میٹرکس، اور لاگز کے لیے ڈیٹا ماڈل + SDKs۔
- **OTLP**: وہ وائر پروٹوکول جس کے ذریعے OTel ڈیٹا کلیکٹر/بیک اینڈ تک برآمد کیا جاتا ہے۔
- OpenClaw آج **OTLP/HTTP (protobuf)** کے ذریعے ایکسپورٹ کرتا ہے۔

### برآمد شدہ سگنلز

- **میٹرکس**: کاؤنٹرز + ہسٹوگرامز (ٹوکن استعمال، پیغام فلو، کیوئنگ)۔
- **ٹریسز**: ماڈل استعمال + ویب ہُک/پیغام پروسیسنگ کے لیے اسپینز۔
- **Logs**: exported over OTLP when `diagnostics.otel.logs` is enabled. Log
  volume can be high; keep `logging.level` and exporter filters in mind.

### تشخیصی ایونٹ کیٹلاگ

ماڈل استعمال:

- `model.usage`: ٹوکنز، لاگت، دورانیہ، سیاق، فراہم کنندہ/ماڈل/چینل، سیشن آئی ڈیز۔

پیغام فلو:

- `webhook.received`: فی چینل ویب ہُک اِن گریس۔
- `webhook.processed`: ویب ہُک ہینڈل ہوا + دورانیہ۔
- `webhook.error`: ویب ہُک ہینڈلر غلطیاں۔
- `message.queued`: پروسیسنگ کے لیے پیغام کیو میں ڈالا گیا۔
- `message.processed`: نتیجہ + دورانیہ + اختیاری خرابی۔

کیو + سیشن:

- `queue.lane.enqueue`: کمانڈ کیو لین اینکیو + گہرائی۔
- `queue.lane.dequeue`: کمانڈ کیو لین ڈی کیو + انتظار کا وقت۔
- `session.state`: سیشن اسٹیٹ ٹرانزیشن + وجہ۔
- `session.stuck`: سیشن اَٹکا ہوا وارننگ + عمر۔
- `run.attempt`: رن ری ٹرائی/کوشش میٹاڈیٹا۔
- `diagnostic.heartbeat`: مجموعی کاؤنٹرز (ویب ہُکس/کیو/سیشن)۔

### تشخیصی معلومات فعال کریں (بغیر ایکسپورٹر)

اگر آپ پلگ اِنز یا کسٹم سنکس کے لیے تشخیصی ایونٹس دستیاب چاہتے ہیں تو یہ استعمال کریں:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### تشخیصی فلیگز (ہدفی لاگز)

Use flags to turn on extra, targeted debug logs without raising `logging.level`.
Flags are case-insensitive and support wildcards (e.g. `telegram.*` or `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env اووررائیڈ (ایک وقتی):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

نوٹس:

- فلیگ لاگز معیاری لاگ فائل میں جاتے ہیں (وہی جو `logging.file` ہے)۔
- آؤٹ پٹ اب بھی `logging.redactSensitive` کے مطابق ریڈیکٹ ہوتا ہے۔
- مکمل رہنما: [/diagnostics/flags](/diagnostics/flags)۔

### OpenTelemetry میں ایکسپورٹ کریں

Diagnostics can be exported via the `diagnostics-otel` plugin (OTLP/HTTP). This
works with any OpenTelemetry collector/backend that accepts OTLP/HTTP.

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

نوٹس:

- آپ پلگ اِن کو `openclaw plugins enable diagnostics-otel` کے ساتھ بھی فعال کر سکتے ہیں۔
- `protocol` currently supports `http/protobuf` only. `grpc` is ignored.
- میٹرکس میں ٹوکن استعمال، لاگت، سیاق سائز، رن دورانیہ، اور پیغام-فلو
  کاؤنٹرز/ہسٹوگرامز (ویب ہُکس، کیوئنگ، سیشن اسٹیٹ، کیو کی گہرائی/انتظار) شامل ہیں۔
- Traces/metrics can be toggled with `traces` / `metrics` (default: on). Traces
  include model usage spans plus webhook/message processing spans when enabled.
- جب آپ کے کلیکٹر کو تصدیق درکار ہو تو `headers` سیٹ کریں۔
- معاون ماحولیاتی متغیرات: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`۔

### برآمد شدہ میٹرکس (نام + اقسام)

ماڈل استعمال:

- `openclaw.tokens` (کاؤنٹر، attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (کاؤنٹر، attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (ہسٹوگرام، attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (ہسٹوگرام، attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

پیغام فلو:

- `openclaw.webhook.received` (کاؤنٹر، attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (کاؤنٹر، attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (ہسٹوگرام، attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (کاؤنٹر، attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (کاؤنٹر، attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (ہسٹوگرام، attrs: `openclaw.channel`,
  `openclaw.outcome`)

کیوز + سیشنز:

- `openclaw.queue.lane.enqueue` (کاؤنٹر، attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (کاؤنٹر، attrs: `openclaw.lane`)
- `openclaw.queue.depth` (ہسٹوگرام، attrs: `openclaw.lane` یا
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (ہسٹوگرام، attrs: `openclaw.lane`)
- `openclaw.session.state` (کاؤنٹر، attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (کاؤنٹر، attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (ہسٹوگرام، attrs: `openclaw.state`)
- `openclaw.run.attempt` (کاؤنٹر، attrs: `openclaw.attempt`)

### برآمد شدہ اسپینز (نام + کلیدی خصوصیات)

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

### سیمپلنگ + فلشنگ

- ٹریس سیمپلنگ: `diagnostics.otel.sampleRate` (0.0–1.0، صرف روٹ اسپینز)۔
- میٹرک ایکسپورٹ وقفہ: `diagnostics.otel.flushIntervalMs` (کم از کم 1000ms)۔

### پروٹوکول نوٹس

- OTLP/HTTP اینڈپوائنٹس `diagnostics.otel.endpoint` یا
  `OTEL_EXPORTER_OTLP_ENDPOINT` کے ذریعے سیٹ کیے جا سکتے ہیں۔
- اگر اینڈپوائنٹ میں پہلے ہی `/v1/traces` یا `/v1/metrics` شامل ہو، تو اسے ویسے ہی استعمال کیا جاتا ہے۔
- اگر اینڈپوائنٹ میں پہلے ہی `/v1/logs` شامل ہو، تو لاگز کے لیے اسے ویسے ہی استعمال کیا جاتا ہے۔
- `diagnostics.otel.logs` مرکزی لاگر آؤٹ پٹ کے لیے OTLP لاگ ایکسپورٹ فعال کرتا ہے۔

### لاگ ایکسپورٹ رویہ

- OTLP لاگز وہی ساختہ ریکارڈز استعمال کرتے ہیں جو `logging.file` میں لکھے جاتے ہیں۔
- Respect `logging.level` (file log level). Console redaction does **not** apply
  to OTLP logs.
- زیادہ والیوم والی انسٹالیشنز کو OTLP کلیکٹر سیمپلنگ/فلٹرنگ کو ترجیح دینی چاہیے۔

## خرابیوں کے ازالے کے مشورے

- **Gateway قابلِ رسائی نہیں؟** پہلے `openclaw doctor` چلائیں۔
- **لاگز خالی ہیں؟** چیک کریں کہ Gateway چل رہا ہے اور
  `logging.file` میں دیے گئے فائل راستے پر لکھ رہا ہے۔
- **مزید تفصیل درکار ہے؟** `logging.level` کو `debug` یا `trace` پر سیٹ کریں اور دوبارہ کوشش کریں۔
