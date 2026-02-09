---
summary: "ہارٹ بیٹ پولنگ پیغامات اور نوٹیفکیشن قواعد"
read_when:
  - ہارٹ بیٹ کی رفتار یا پیغام رسانی میں ایڈجسٹمنٹ کرتے وقت
  - شیڈیول شدہ کاموں کے لیے ہارٹ بیٹ اور کرون کے درمیان فیصلہ کرتے وقت
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat بمقابلہ Cron؟** ہر ایک کے استعمال کے بارے میں رہنمائی کے لیے [Cron vs Heartbeat](/automation/cron-vs-heartbeat) دیکھیں۔

Heartbeat مرکزی سیشن میں **دوریاتی ایجنٹ ٹرنز** چلاتا ہے تاکہ ماڈل
کسی بھی ایسی چیز کو سامنے لا سکے جس پر توجہ درکار ہو، بغیر آپ کو غیر ضروری پیغامات بھیجے۔

خرابیوں کا ازالہ: [/automation/troubleshooting](/automation/troubleshooting)

## فوری آغاز (مبتدی)

1. ہارٹ بیٹس کو فعال رہنے دیں (بطورِ طے شدہ `30m`، یا Anthropic OAuth/setup-token کے لیے `1h`) یا اپنی رفتار سیٹ کریں۔
2. ایجنٹ ورک اسپیس میں ایک مختصر `HEARTBEAT.md` چیک لسٹ بنائیں (اختیاری مگر سفارش کردہ)۔
3. یہ طے کریں کہ ہارٹ بیٹ پیغامات کہاں جائیں (`target: "last"` بطورِ طے شدہ ہے)۔
4. اختیاری: شفافیت کے لیے ہارٹ بیٹ کی reasoning ڈیلیوری فعال کریں۔
5. اختیاری: ہارٹ بیٹس کو فعال اوقات (مقامی وقت) تک محدود کریں۔

مثالی کنفیگ:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## طے شدہ اقدار

- وقفہ: `30m` (یا `1h` جب Anthropic OAuth/setup-token معلوم شدہ auth موڈ ہو)۔ `agents.defaults.heartbeat.every` یا فی ایجنٹ `agents.list[].heartbeat.every` سیٹ کریں؛ غیر فعال کرنے کے لیے `0m` استعمال کریں۔
- پرامپٹ باڈی (جسے `agents.defaults.heartbeat.prompt` کے ذریعے کنفیگر کیا جا سکتا ہے):
  `Read HEARTBEAT.md if it exists (workspace context). اس پر سختی سے عمل کریں۔ پچھلی چیٹس کے پرانے کاموں کا اندازہ نہ لگائیں اور نہ دہرائیں۔ اگر کسی توجہ کی ضرورت نہ ہو تو HEARTBEAT_OK کے ساتھ جواب دیں۔`
- ہارٹ بیٹ پرامپٹ صارف کے پیغام کے طور پر **لفظ بہ لفظ** بھیجا جاتا ہے۔ سسٹم پرامپٹ میں “Heartbeat” سیکشن شامل ہوتا ہے اور رَن کو اندرونی طور پر فلیگ کیا جاتا ہے۔
- فعال اوقات (`heartbeat.activeHours`) کنفیگر شدہ ٹائم زون میں چیک کیے جاتے ہیں۔
  ونڈو سے باہر، ہارٹ بیٹس اگلے ٹِک تک چھوڑ دیے جاتے ہیں جو ونڈو کے اندر ہو۔

## ہارٹ بیٹ پرامپٹ کا مقصد

بطورِ طے شدہ پرامپٹ جان بوجھ کر عمومی رکھا گیا ہے:

- **پسِ منظر کام**: “Consider outstanding tasks” ایجنٹ کو فالو اَپس
  (ان باکس، کیلنڈر، یاد دہانیاں، قطار میں موجود کام) کا جائزہ لینے اور کسی بھی فوری چیز کو سامنے لانے پر آمادہ کرتا ہے۔
- **انسانی چیک اِن**: “Checkup sometimes on your human during day time” کبھی کبھار ایک ہلکا پھلکا “کیا آپ کو کسی چیز کی ضرورت ہے؟” پیغام بھیجنے کی ترغیب دیتا ہے، مگر آپ کے کنفیگر کردہ مقامی ٹائم زون کے ذریعے رات کے وقت اسپام سے بچتا ہے (دیکھیں [/concepts/timezone](/concepts/timezone))۔

اگر آپ چاہتے ہیں کہ ہارٹ بیٹ کوئی بالکل مخصوص کام کرے (مثلاً “check Gmail PubSub
stats” یا “verify gateway health”) تو `agents.defaults.heartbeat.prompt` (یا
`agents.list[].heartbeat.prompt`) کو حسبِ ضرورت باڈی پر سیٹ کریں (بعینہٖ بھیجی جاتی ہے)۔

## ردِعمل کا معاہدہ

- اگر توجہ کی کوئی ضرورت نہ ہو تو **`HEARTBEAT_OK`** کے ساتھ جواب دیں۔
- ہارٹ بیٹ رنز کے دوران، OpenClaw `HEARTBEAT_OK` کو ایک ack سمجھتا ہے جب یہ جواب کے **آغاز یا اختتام** پر ظاہر ہو۔ ٹوکن ہٹا دیا جاتا ہے اور جواب ڈراپ کر دیا جاتا ہے اگر باقی مواد **≤ `ackMaxChars`** (ڈیفالٹ: 300) ہو۔
- اگر `HEARTBEAT_OK` جواب کے **درمیان** آئے تو اسے خاص طور پر نہیں سمجھا جاتا۔
- الرٹس کے لیے، **`HEARTBEAT_OK` شامل نہ کریں**؛ صرف الرٹ متن واپس کریں۔

ہارٹ بیٹس کے باہر، پیغام کے آغاز/اختتام پر آنے والا بے جا `HEARTBEAT_OK` ہٹا کر لاگ کیا جاتا ہے؛ صرف `HEARTBEAT_OK` پر مشتمل پیغام چھوڑ دیا جاتا ہے۔

## کنفیگ

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### دائرہ کار اور ترجیح

- `agents.defaults.heartbeat` عالمی ہارٹ بیٹ رویّہ سیٹ کرتا ہے۔
- `agents.list[].heartbeat` اوپر سے مرج ہوتا ہے؛ اگر کسی ایجنٹ میں `heartbeat` بلاک ہو تو **صرف وہی ایجنٹس** ہارٹ بیٹس چلاتے ہیں۔
- `channels.defaults.heartbeat` تمام چینلز کے لیے مرئیّت کی طے شدہ اقدار سیٹ کرتا ہے۔
- `channels.<channel>.heartbeat` چینل ڈیفالٹس کو اوور رائیڈ کرتا ہے۔
- `channels.<channel>.accounts.<id>.heartbeat` (ملٹی اکاؤنٹ چینلز) فی چینل سیٹنگز کو اوور رائیڈ کرتا ہے۔

### ہر ایجنٹ کے لیے ہارٹ بیٹس

اگر کسی `agents.list[]` انٹری میں `heartbeat` بلاک شامل ہو تو **صرف وہی ایجنٹس** ہارٹ بیٹس چلاتے ہیں۔ فی ایجنٹ بلاک `agents.defaults.heartbeat` کے اوپر مرج ہوتا ہے (تاکہ آپ مشترکہ ڈیفالٹس ایک بار سیٹ کریں اور فی ایجنٹ اوور رائیڈ کریں)۔

مثال: دو ایجنٹس، صرف دوسرا ایجنٹ ہارٹ بیٹس چلاتا ہے۔

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### فعال اوقات کی مثال

کسی مخصوص ٹائم زون میں کاروباری اوقات تک ہارٹ بیٹس محدود کریں:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

اس ونڈو سے باہر (صبح 9 بجے سے پہلے یا رات 10 بجے کے بعد مشرقی وقت)، ہارٹ بیٹس چھوڑ دیے جاتے ہیں۔ ونڈو کے اندر اگلا شیڈولڈ ٹِک معمول کے مطابق چلے گا۔

### ملٹی اکاؤنٹ مثال

Telegram جیسے ملٹی اکاؤنٹ چینلز پر کسی مخصوص اکاؤنٹ کو ہدف بنانے کے لیے `accountId` استعمال کریں:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### فیلڈ نوٹس

- `every`: ہارٹ بیٹ وقفہ (مدت کی اسٹرنگ؛ بطورِ طے شدہ اکائی = منٹس)۔
- `model`: ہارٹ بیٹ رنز کے لیے اختیاری ماڈل اووررائیڈ (`provider/model`)۔
- `includeReasoning`: فعال ہونے پر، دستیاب ہونے کی صورت میں علیحدہ `Reasoning:` پیغام بھی ڈیلیور کریں (وہی ساخت جیسی `/reasoning on`)۔
- `session`: ہارٹ بیٹ رنز کے لیے اختیاری سیشن کی۔
  - `main` (بطورِ طے شدہ): ایجنٹ کا مرکزی سیشن۔
  - صراحتی سیشن کی ( `openclaw sessions --json` یا [sessions CLI](/cli/sessions) سے کاپی کریں)۔
  - سیشن کی فارمیٹس: [Sessions](/concepts/session) اور [Groups](/channels/groups) دیکھیں۔
- `target`:
  - `last` (بطورِ طے شدہ): آخری استعمال شدہ بیرونی چینل پر ڈیلیور کریں۔
  - صراحتی چینل: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`۔
  - `none`: ہارٹ بیٹ چلائیں مگر بیرونی طور پر **ڈیلیور نہ کریں**۔
- `to`: اختیاری وصول کنندہ اووررائیڈ (چینل مخصوص آئی ڈی، مثلاً WhatsApp کے لیے E.164 یا Telegram چیٹ آئی ڈی)۔
- `accountId`: ملٹی اکاؤنٹ چینلز کے لیے اختیاری اکاؤنٹ آئی ڈی۔ جب `target: "last"` ہو تو اکاؤنٹ آئی ڈی حل شدہ آخری چینل پر لاگو ہوتی ہے اگر وہ اکاؤنٹس کو سپورٹ کرتا ہو؛ بصورت دیگر اسے نظر انداز کر دیا جاتا ہے۔ اگر اکاؤنٹ آئی ڈی حل شدہ چینل کے لیے کنفیگر شدہ اکاؤنٹ سے میل نہ کھائے تو ترسیل چھوڑ دی جاتی ہے۔
- `prompt`: طے شدہ پرامپٹ باڈی کو اووررائیڈ کرتا ہے (مرج نہیں ہوتا)۔
- `ackMaxChars`: `HEARTBEAT_OK` کے بعد ڈیلیوری سے پہلے زیادہ سے زیادہ اجازت یافتہ کریکٹرز۔
- `activeHours`: ہارٹ بیٹ رنز کو ایک وقت کی ونڈو تک محدود کرتا ہے۔ ایک آبجیکٹ جس میں `start` (HH:MM، شامل)، `end` (HH:MM، خارج؛ دن کے اختتام کے لیے `24:00` کی اجازت)، اور اختیاری `timezone` شامل ہوں۔
  - چھوڑ دیا جائے یا `"user"`: اگر سیٹ ہو تو آپ کا `agents.defaults.userTimezone` استعمال کرتا ہے، ورنہ ہوسٹ سسٹم ٹائم زون پر واپس جاتا ہے۔
  - `"local"`: ہمیشہ ہوسٹ سسٹم ٹائم زون استعمال کرتا ہے۔
  - کوئی بھی IANA شناخت کنندہ (مثلاً `America/New_York`): براہِ راست استعمال کیا جاتا ہے؛ اگر غلط ہو تو اوپر بیان کردہ `"user"` رویّے پر واپس جاتا ہے۔
  - فعال ونڈو سے باہر ہارٹ بیٹس چھوڑ دیے جاتے ہیں جب تک اگلا ٹِک ونڈو کے اندر نہ آ جائے۔

## ڈیلیوری رویّہ

- Heartbeats run in the agent’s main session by default (`agent:<id>:<mainKey>`),
  or `global` when `session.scope = "global"`. Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` صرف رن کانٹیکسٹ کو متاثر کرتا ہے؛ ڈیلیوری `target` اور `to` کے ذریعے کنٹرول ہوتی ہے۔
- To deliver to a specific channel/recipient, set `target` + `to`. کے ساتھ
  `target: "last"`، ڈیلیوری اس سیشن کے لیے آخری بیرونی چینل استعمال کرتی ہے۔
- اگر مرکزی قطار مصروف ہو تو ہارٹ بیٹ چھوڑ دیا جاتا ہے اور بعد میں دوبارہ کوشش کی جاتی ہے۔
- اگر `target` کسی بیرونی منزل پر حل نہ ہو تو رن پھر بھی ہوتا ہے مگر کوئی بیرونی پیغام نہیں بھیجا جاتا۔
- صرف ہارٹ بیٹ والے جوابات سیشن کو زندہ **نہیں** رکھتے؛ آخری `updatedAt`
  بحال کر دیا جاتا ہے تاکہ غیرفعال ختم ہونے کا رویّہ معمول کے مطابق رہے۔

## مرئیّت کنٹرولز

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is
delivered. You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

ترجیح: فی اکاؤنٹ → فی چینل → چینل ڈیفالٹس → بلٹ اِن ڈیفالٹس۔

### ہر فلیگ کیا کرتا ہے

- `showOk`: جب ماڈل صرف OK پر مشتمل جواب دے تو `HEARTBEAT_OK` acknowledgment بھیجتا ہے۔
- `showAlerts`: جب ماڈل غیر OK جواب دے تو الرٹ مواد بھیجتا ہے۔
- `useIndicator`: UI اسٹیٹس سرفسز کے لیے انڈیکیٹر ایونٹس خارج کرتا ہے۔

اگر **تینوں** false ہوں تو OpenClaw ہارٹ بیٹ رن مکمل طور پر چھوڑ دیتا ہے (کوئی ماڈل کال نہیں)۔

### فی چینل بمقابلہ فی اکاؤنٹ مثالیں

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### عام پیٹرنز

| مقصد                                                                | کنفیگ                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| طے شدہ رویّہ (خاموش OKs، الرٹس آن)               | _(کنفیگ درکار نہیں)_                                                  |
| مکمل خاموش (کوئی پیغام نہیں، کوئی انڈیکیٹر نہیں) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| صرف انڈیکیٹر (کوئی پیغامات نہیں)                 | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| صرف ایک چینل میں OKs                                                | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (اختیاری)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Think of it as your “heartbeat checklist”: small, stable, and
safe to include every 30 minutes.

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
اگر فائل غائب ہو تو ہارٹ بیٹ پھر بھی چلتا ہے اور ماڈل فیصلہ کرتا ہے کہ کیا کرنا ہے۔

اسے مختصر رکھیں (چھوٹی چیک لسٹ یا یاد دہانیاں) تاکہ پرامپٹ پھولنے سے بچا جا سکے۔

مثالی `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### کیا ایجنٹ HEARTBEAT.md کو اپ ڈیٹ کر سکتا ہے؟

ہاں — اگر آپ اس سے کہیں۔

`HEARTBEAT.md` ایجنٹ ورک اسپیس میں ایک عام فائل ہے، اس لیے آپ ایجنٹ کو
(عام چیٹ میں) کچھ یوں کہہ سکتے ہیں:

- “`HEARTBEAT.md` اپ ڈیٹ کریں تاکہ روزانہ کیلنڈر چیک شامل ہو۔”
- “`HEARTBEAT.md` کو دوبارہ لکھیں تاکہ یہ مختصر ہو اور ان باکس فالو اَپس پر مرکوز رہے۔”

اگر آپ چاہتے ہیں کہ یہ کام پیشگی طور پر ہو تو آپ اپنے ہارٹ بیٹ پرامپٹ میں ایک واضح لائن بھی شامل کر سکتے ہیں جیسے:
“اگر چیک لسٹ پرانی ہو جائے تو HEARTBEAT.md کو بہتر والی سے اپ ڈیٹ کریں۔”

حفاظتی نوٹ: `HEARTBEAT.md` میں راز (API keys، فون نمبرز، نجی ٹوکنز) نہ ڈالیں — یہ پرامپٹ سیاق کا حصہ بن جاتا ہے۔

## دستی بیداری (درخواست پر)

آپ سسٹم ایونٹ قطار میں ڈال کر فوراً ہارٹ بیٹ ٹرگر کر سکتے ہیں:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

اگر متعدد ایجنٹس میں `heartbeat` کنفیگر ہو تو دستی بیداری ان سب کے
ہارٹ بیٹس فوراً چلا دیتی ہے۔

اگلے شیڈیول شدہ ٹِک کا انتظار کرنے کے لیے `--mode next-heartbeat` استعمال کریں۔

## Reasoning ڈیلیوری (اختیاری)

بطورِ طے شدہ، ہارٹ بیٹس صرف آخری “جواب” پے لوڈ ڈیلیور کرتے ہیں۔

اگر آپ شفافیت چاہتے ہیں تو فعال کریں:

- `agents.defaults.heartbeat.includeReasoning: true`

جب فعال ہو، ہارٹ بیٹس ایک علیحدہ پیغام بھی ڈیلیور کریں گے جس کے آغاز میں
`Reasoning:` ہوگا (وہی ساخت جیسی `/reasoning on`)۔ This can be useful when the agent
is managing multiple sessions/codexes and you want to see why it decided to ping
you — but it can also leak more internal detail than you want. Prefer keeping it
off in group chats.

## لاگت سے آگاہی

ہارٹ بیٹس مکمل ایجنٹ ٹرنز چلاتے ہیں۔ Shorter intervals burn more tokens. Keep
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you
only want internal state updates.
