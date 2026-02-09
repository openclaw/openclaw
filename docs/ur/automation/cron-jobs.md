---
summary: "Gateway شیڈیولر کے لیے کرون جابز + ویک اپس"
read_when:
  - پسِ منظر جابز یا ویک اپس کی شیڈیولنگ
  - ایسی آٹومیشن جو ہارٹ بیٹس کے ساتھ یا ان کے ہمراہ چلنی چاہیے
  - شیڈیول شدہ ٹاسکس کے لیے ہارٹ بیٹ اور کرون کے درمیان انتخاب
title: "Cron Jobs"
---

# کرون جابز (Gateway شیڈیولر)

> **Cron بمقابلہ Heartbeat؟** یہ جاننے کے لیے کہ ہر ایک کب استعمال کرنا ہے، [Cron vs Heartbeat](/automation/cron-vs-heartbeat) دیکھیں۔

Cron گیٹ وے کا بلٹ اِن شیڈیولر ہے۔ It persists jobs, wakes the agent at
the right time, and can optionally deliver output back to a chat.

اگر آپ چاہتے ہیں _“یہ ہر صبح چلاؤ”_ یا _“20 منٹ بعد ایجنٹ کو چھیڑو”_، تو کرون ہی طریقۂ کار ہے۔

خرابیوں کا ازالہ: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron **Gateway کے اندر** چلتا ہے (ماڈل کے اندر نہیں)۔
- جابز `~/.openclaw/cron/` کے تحت محفوظ رہتی ہیں تاکہ ری اسٹارٹ پر شیڈیول ضائع نہ ہوں۔
- عمل درآمد کے دو انداز:
  - **مین سیشن**: ایک سسٹم ایونٹ قطار میں ڈالیں، پھر اگلے ہارٹ بیٹ پر چلائیں۔
  - **Isolated**: `cron:<jobId>` میں ایک مخصوص ایجنٹ ٹرن چلائیں، ڈیلیوری کے ساتھ (بطورِ طے شدہ اعلان یا کوئی نہیں)۔
- ویک اپس فرسٹ کلاس ہیں: جاب “ابھی جگاؤ” بمقابلہ “اگلا ہارٹ بیٹ” کی درخواست کر سکتی ہے۔

## فوری آغاز (عملی)

ایک ون شاٹ یاد دہانی بنائیں، اس کے وجود کی تصدیق کریں، اور فوراً چلائیں:

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

ڈیلیوری کے ساتھ ایک ری کرنگ isolated جاب شیڈیول کریں:

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

## ٹول کال کے مساویات (Gateway cron tool)

معیاری JSON ساختوں اور مثالوں کے لیے دیکھیں: [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls)۔

## کرون جابز کہاں محفوظ ہوتی ہیں

Cron جابز بطورِ ڈیفالٹ گیٹ وے ہوسٹ پر `~/.openclaw/cron/jobs.json` میں محفوظ ہوتی ہیں۔
گیٹ وے فائل کو میموری میں لوڈ کرتا ہے اور تبدیلیوں پر اسے واپس لکھتا ہے، اس لیے دستی ترمیم صرف تب محفوظ ہے جب گیٹ وے بند ہو۔ Prefer `openclaw cron add/edit` or the cron
tool call API for changes.

## مبتدیوں کے لیے جائزہ

کرون جاب کو یوں سمجھیں: **کب** چلانا ہے + **کیا** کرنا ہے۔

1. **شیڈیول منتخب کریں**
   - ون شاٹ یاد دہانی → `schedule.kind = "at"` (CLI: `--at`)
   - ری کرنگ جاب → `schedule.kind = "every"` یا `schedule.kind = "cron"`
   - اگر آپ کے ISO ٹائم اسٹیمپ میں ٹائم زون شامل نہیں، تو اسے **UTC** سمجھا جاتا ہے۔

2. **کہاں چلتی ہے منتخب کریں**
   - `sessionTarget: "main"` → مین سیاق کے ساتھ اگلے ہارٹ بیٹ کے دوران چلائیں۔
   - `sessionTarget: "isolated"` → `cron:<jobId>` میں ایک مخصوص ایجنٹ ٹرن چلائیں۔

3. **پے لوڈ منتخب کریں**
   - مین سیشن → `payload.kind = "systemEvent"`
   - Isolated سیشن → `payload.kind = "agentTurn"`

اختیاری: ون شاٹ جابز (`schedule.kind = "at"`) بطورِ ڈیفالٹ کامیابی کے بعد حذف ہو جاتی ہیں۔ انہیں برقرار رکھنے کے لیے `deleteAfterRun: false` سیٹ کریں (کامیابی کے بعد یہ غیر فعال ہو جائیں گی)۔

## تصورات

### جابز

ایک کرون جاب ایک محفوظ ریکارڈ ہے جس میں شامل ہوتا ہے:

- ایک **شیڈیول** (کب چلنا ہے)،
- ایک **پے لوڈ** (کیا کرنا ہے)،
- اختیاری **ڈیلیوری موڈ** (اعلان یا کوئی نہیں)،
- اختیاری **ایجنٹ بائنڈنگ** (`agentId`): کسی مخصوص ایجنٹ کے تحت جاب چلائیں؛ اگر
  غائب یا نامعلوم ہو تو gateway ڈیفالٹ ایجنٹ پر واپس چلا جاتا ہے۔

جابز کی شناخت ایک مستحکم `jobId` سے ہوتی ہے (CLI/گیٹ وے APIs میں استعمال ہوتا ہے)۔
ایجنٹ ٹول کالز میں `jobId` معیاری ہے؛ مطابقت کے لیے لیگیسی `id` قبول کی جاتی ہے۔
ون شاٹ جابز بطورِ ڈیفالٹ کامیابی کے بعد خودکار طور پر حذف ہو جاتی ہیں؛ انہیں رکھنے کے لیے `deleteAfterRun: false` سیٹ کریں۔

### شیڈیولز

Cron تین اقسام کے شیڈیول سپورٹ کرتا ہے:

- `at`: `schedule.at` (ISO 8601) کے ذریعے ون شاٹ ٹائم اسٹیمپ۔
- `every`: مقررہ وقفہ (ملی سیکنڈز)۔
- `cron`: 5-فیلڈ کرون ایکسپریشن، اختیاری IANA ٹائم زون کے ساتھ۔

Cron expressions use `croner`. اگر ٹائم زون چھوڑ دیا جائے تو گیٹ وے ہوسٹ کا مقامی ٹائم زون استعمال ہوتا ہے۔

### مین بمقابلہ isolated عمل درآمد

#### مین سیشن جابز (سسٹم ایونٹس)

مین جابز ایک سسٹم ایونٹ کی قطار بناتی ہیں اور اختیاری طور پر ہارٹ بیٹ رنر کو جگاتی ہیں۔
They must use `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (ڈیفالٹ): ایونٹ فوراً ہارٹ بیٹ رن کو متحرک کرتا ہے۔
- `wakeMode: "next-heartbeat"`: ایونٹ اگلے مقررہ ہارٹ بیٹ کا انتظار کرتا ہے۔

یہ اس وقت بہترین انتخاب ہے جب آپ نارمل ہارٹ بیٹ پرامپٹ + مین سیشن کانٹیکسٹ چاہتے ہوں۔
See [Heartbeat](/gateway/heartbeat).

#### Isolated جابز (مخصوص کرون سیشنز)

Isolated جابز سیشن `cron:<jobId>` میں ایک مخصوص ایجنٹ ٹرن چلاتی ہیں۔

اہم رویّے:

- ٹریس ایبلٹی کے لیے پرامپٹ کے آغاز میں `[cron:<jobId> <job name>]` شامل کیا جاتا ہے۔
- ہر رن ایک **نیا سیشن id** شروع کرتا ہے (پچھلی گفتگو منتقل نہیں ہوتی)۔
- ڈیفالٹ رویہ: اگر `delivery` شامل نہ ہو تو isolated جابز خلاصہ اعلان کرتی ہیں (`delivery.mode = "announce"`)۔
- `delivery.mode` (صرف isolated) یہ منتخب کرتا ہے کہ کیا ہوگا:
  - `announce`: ہدف چینل پر خلاصہ ڈیلیور کریں اور مین سیشن میں مختصر خلاصہ پوسٹ کریں۔
  - `none`: صرف اندرونی (کوئی ڈیلیوری نہیں، کوئی مین سیشن خلاصہ نہیں)۔
- `wakeMode` یہ کنٹرول کرتا ہے کہ مین سیشن خلاصہ کب پوسٹ ہو:
  - `now`: فوری ہارٹ بیٹ۔
  - `next-heartbeat`: اگلے مقررہ ہارٹ بیٹ کا انتظار۔

Isolated جابز اُن شور دار، بار بار چلنے والے، یا "پسِ منظر کاموں" کے لیے استعمال کریں جو
آپ کی مین چیٹ ہسٹری کو اسپام نہ کریں۔

### پے لوڈ کی ساختیں (کیا چلتا ہے)

دو اقسام کے پے لوڈ سپورٹ ہوتے ہیں:

- `systemEvent`: صرف مین سیشن، ہارٹ بیٹ پرامپٹ کے ذریعے روٹ ہوتا ہے۔
- `agentTurn`: صرف isolated سیشن، ایک مخصوص ایجنٹ ٹرن چلاتا ہے۔

عام `agentTurn` فیلڈز:

- `message`: لازم متنی پرامپٹ۔
- `model` / `thinking`: اختیاری اووررائیڈز (نیچے دیکھیں)۔
- `timeoutSeconds`: اختیاری ٹائم آؤٹ اووررائیڈ۔

ڈیلیوری کنفیگ (صرف isolated جابز):

- `delivery.mode`: `none` | `announce`۔
- `delivery.channel`: `last` یا کوئی مخصوص چینل۔
- `delivery.to`: چینل مخصوص ہدف (فون/چیٹ/چینل id)۔
- `delivery.bestEffort`: اگر اعلان کی ڈیلیوری ناکام ہو تو جاب کو فیل ہونے سے بچائیں۔

Announce ڈیلیوری رن کے دوران میسجنگ ٹول بھیجنے کو دبا دیتی ہے؛ اس کے بجائے چیٹ کو ہدف بنانے کے لیے `delivery.channel`/`delivery.to` استعمال کریں۔ جب `delivery.mode = "none"` ہو تو مین سیشن میں کوئی خلاصہ پوسٹ نہیں ہوتا۔

اگر isolated جابز کے لیے `delivery` شامل نہ ہو تو OpenClaw بطورِ طے شدہ `announce` استعمال کرتا ہے۔

#### اعلان ڈیلیوری کا بہاؤ

جب `delivery.mode = "announce"` ہو تو cron براہِ راست آؤٹ باؤنڈ چینل اڈاپٹرز کے ذریعے ڈیلیور کرتا ہے۔
مین ایجنٹ پیغام تیار کرنے یا فارورڈ کرنے کے لیے اسپن اپ نہیں ہوتا۔

رویہ کی تفصیلات:

- مواد: ڈیلیوری isolated رن کے آؤٹ باؤنڈ پے لوڈز (متن/میڈیا) کو عام چنکنگ اور
  چینل فارمیٹنگ کے ساتھ استعمال کرتی ہے۔
- صرف ہارٹ بیٹ والے جوابات (`HEARTBEAT_OK` بغیر حقیقی مواد کے) ڈیلیور نہیں ہوتے۔
- اگر isolated رن نے پہلے ہی اسی ہدف پر میسج ٹول کے ذریعے پیغام بھیج دیا ہو تو
  نقل سے بچنے کے لیے ڈیلیوری چھوڑ دی جاتی ہے۔
- غائب یا غلط ڈیلیوری اہداف جاب کو فیل کر دیتے ہیں، الا یہ کہ `delivery.bestEffort = true` ہو۔
- مختصر خلاصہ مین سیشن میں صرف تب پوسٹ ہوتا ہے جب `delivery.mode = "announce"` ہو۔
- مین سیشن خلاصہ `wakeMode` کا احترام کرتا ہے: `now` فوری ہارٹ بیٹ کو متحرک کرتا ہے اور
  `next-heartbeat` اگلے مقررہ ہارٹ بیٹ کا انتظار کرتا ہے۔

### ماڈل اور تھنکنگ اووررائیڈز

Isolated جابز (`agentTurn`) ماڈل اور تھنکنگ لیول اووررائیڈ کر سکتی ہیں:

- `model`: فراہم کنندہ/ماڈل اسٹرنگ (مثلاً `anthropic/claude-sonnet-4-20250514`) یا عرفی نام (مثلاً `opus`)
- `thinking`: تھنکنگ لیول (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; صرف GPT-5.2 + Codex ماڈلز)

نوٹ: آپ مین سیشن جابز پر بھی `model` سیٹ کر سکتے ہیں، لیکن یہ مشترکہ مین سیشن ماڈل کو بدل دیتا ہے۔ ہم غیر متوقع کانٹیکسٹ تبدیلیوں سے بچنے کے لیے ماڈل اوور رائیڈز کو صرف الگ تھلگ جابز کے لیے تجویز کرتے ہیں۔

حل کی ترجیح:

1. جاب پے لوڈ اووررائیڈ (اعلیٰ ترین)
2. ہُک مخصوص ڈیفالٹس (مثلاً `hooks.gmail.model`)
3. ایجنٹ کنفیگ ڈیفالٹ

### ڈیلیوری (چینل + ہدف)

Isolated جابز ٹاپ لیول `delivery` کنفیگ کے ذریعے چینل پر آؤٹ پٹ ڈیلیور کر سکتی ہیں:

- `delivery.mode`: `announce` (خلاصہ ڈیلیور کریں) یا `none`۔
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (پلگ اِن) / `signal` / `imessage` / `last`۔
- `delivery.to`: چینل مخصوص وصول کنندہ ہدف۔

ڈیلیوری کنفیگ صرف isolated جابز کے لیے درست ہے (`sessionTarget: "isolated"`)۔

اگر `delivery.channel` یا `delivery.to` شامل نہ ہو تو کرون مین سیشن کے
“آخری راستے” پر واپس جا سکتا ہے (وہ آخری جگہ جہاں ایجنٹ نے جواب دیا تھا)۔

ہدف فارمیٹ کی یاد دہانیاں:

- Slack/Discord/Mattermost (پلگ اِن) اہداف میں ابہام سے بچنے کے لیے واضح پری فکسز استعمال کریں (مثلاً `channel:<id>`, `user:<id>`)۔
- Telegram ٹاپکس کے لیے `:topic:` فارم استعمال کریں (نیچے دیکھیں)۔

#### Telegram ڈیلیوری اہداف (ٹاپکس / فورم تھریڈز)

Telegram `message_thread_id` کے ذریعے فورم ٹاپکس کو سپورٹ کرتا ہے۔ cron ڈیلیوری کے لیے، آپ ٹاپک/تھریڈ کو `to` فیلڈ میں انکوڈ کر سکتے ہیں:

- `-1001234567890` (صرف چیٹ id)
- `-1001234567890:topic:123` (ترجیحی: واضح ٹاپک مارکر)
- `-1001234567890:123` (مختصر: عددی لاحقہ)

`telegram:...` / `telegram:group:...` جیسے پری فکس شدہ اہداف بھی قبول ہیں:

- `telegram:group:-1001234567890:topic:123`

## ٹول کالز کے لیے JSON اسکیما

Use these shapes when calling Gateway `cron.*` tools directly (agent tool calls or RPC).
CLI فلیگز انسانی دورانیے جیسے `20m` قبول کرتے ہیں، لیکن ٹول کالز میں `schedule.at` کے لیے ISO 8601 اسٹرنگ اور `schedule.everyMs` کے لیے ملی سیکنڈز استعمال کریں۔

### cron.add پیرامیٹرز

ون شاٹ، مین سیشن جاب (سسٹم ایونٹ):

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

ری کرنگ، isolated جاب ڈیلیوری کے ساتھ:

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

نوٹس:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), یا `cron` (`expr`, اختیاری `tz`)۔
- `schedule.at` ISO 8601 قبول کرتا ہے (ٹائم زون اختیاری؛ شامل نہ ہو تو UTC سمجھا جاتا ہے)۔
- `everyMs` ملی سیکنڈز میں ہے۔
- `sessionTarget` لازماً `"main"` یا `"isolated"` ہو اور `payload.kind` سے میل کھاتا ہو۔
- اختیاری فیلڈز: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at` کے لیے بطورِ طے شدہ true)،
  `delivery`۔
- `wakeMode` اگر شامل نہ ہو تو بطورِ طے شدہ `"now"` ہوتا ہے۔

### cron.update پیرامیٹرز

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

نوٹس:

- `jobId` معیاری ہے؛ مطابقت کے لیے `id` قبول کیا جاتا ہے۔
- ایجنٹ بائنڈنگ صاف کرنے کے لیے پیچ میں `agentId: null` استعمال کریں۔

### cron.run اور cron.remove پیرامیٹرز

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## اسٹوریج اور ہسٹری

- جاب اسٹور: `~/.openclaw/cron/jobs.json` (Gateway کے زیرِ انتظام JSON)۔
- رن ہسٹری: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL، خودکار صفائی کے ساتھ)۔
- اسٹور پاتھ اووررائیڈ کریں: کنفیگ میں `cron.store`۔

## کنفیگریشن

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

کرون کو مکمل طور پر غیر فعال کریں:

- `cron.enabled: false` (کنفیگ)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI فوری آغاز

ون شاٹ یاد دہانی (UTC ISO، کامیابی کے بعد خودکار حذف):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

ون شاٹ یاد دہانی (مین سیشن، فوراً ویک):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

ری کرنگ isolated جاب (WhatsApp پر اعلان):

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

ری کرنگ isolated جاب (Telegram ٹاپک پر ڈیلیور):

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

ماڈل اور تھنکنگ اووررائیڈ کے ساتھ isolated جاب:

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

ایجنٹ انتخاب (ملٹی ایجنٹ سیٹ اپس):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

دستی رن (force بطورِ طے شدہ ہے؛ صرف واجب الادا پر چلانے کے لیے `--due` استعمال کریں):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

موجودہ جاب میں ترمیم (فیلڈز پیچ کریں):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

رن ہسٹری:

```bash
openclaw cron runs --id <jobId> --limit 50
```

جاب بنائے بغیر فوری سسٹم ایونٹ:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API سطح

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force یا due)، `cron.runs`
  جاب کے بغیر فوری سسٹم ایونٹس کے لیے [`openclaw system event`](/cli/system) استعمال کریں۔

## خرابیوں کا ازالہ

### “کچھ بھی نہیں چل رہا”

- چیک کریں کہ کرون فعال ہے: `cron.enabled` اور `OPENCLAW_SKIP_CRON`۔
- چیک کریں کہ Gateway مسلسل چل رہا ہے (کرون Gateway پراسیس کے اندر چلتا ہے)۔
- `cron` شیڈیولز کے لیے: ٹائم زون (`--tz`) بمقابلہ ہوسٹ ٹائم زون کی تصدیق کریں۔

### ری کرنگ جاب ناکامیوں کے بعد تاخیر کرتی رہتی ہے

- OpenClaw، مسلسل غلطیوں کے بعد ری کرنگ جابز پر ایکسپونینشل ری ٹرائی بیک آف لاگو کرتا ہے:
  30s، 1m، 5m، 15m، پھر ری ٹرائز کے درمیان 60m۔
- اگلی کامیاب رن کے بعد بیک آف خود بخود ری سیٹ ہو جاتا ہے۔
- ون شاٹ (`at`) جابز ایک ٹرمینل رن (`ok`, `error`, یا `skipped`) کے بعد غیر فعال ہو جاتی ہیں اور دوبارہ کوشش نہیں کرتیں۔

### Telegram غلط جگہ ڈیلیور کر رہا ہے

- فورم ٹاپکس کے لیے `-100…:topic:<id>` استعمال کریں تاکہ بات واضح اور غیر مبہم رہے۔
- اگر لاگز یا محفوظ شدہ “آخری راستہ” اہداف میں `telegram:...` پری فکسز نظر آئیں تو یہ معمول کی بات ہے؛
  کرون ڈیلیوری انہیں قبول کرتی ہے اور پھر بھی ٹاپک IDs درست طور پر پارس کرتی ہے۔
