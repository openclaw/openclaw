---
summary: "ایجنٹ لوپ کی لائف سائیکل، اسٹریمز، اور انتظار کے معنی"
read_when:
  - آپ کو ایجنٹ لوپ یا لائف سائیکل ایونٹس کی عین مطابق مرحلہ وار وضاحت درکار ہو
title: "Agent Loop"
x-i18n:
  source_path: concepts/agent-loop.md
  source_hash: e2c14fb74bd42caa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:24Z
---

# Agent Loop (OpenClaw)

ایجنٹک لوپ ایجنٹ کی مکمل “حقیقی” رَن ہوتی ہے: انٹیک → سیاق کی تیاری → ماڈل انفرنس →
اوزاروں کا اجرا → جوابات کی اسٹریمنگ → مستقل ذخیرہ۔ یہ وہ مستند راستہ ہے جو ایک پیغام کو
اعمال اور حتمی جواب میں تبدیل کرتا ہے، جبکہ سیشن کی حالت کو ہم آہنگ رکھتا ہے۔

OpenClaw میں، لوپ فی سیشن ایک واحد، سلسلہ وار رَن ہوتی ہے جو لائف سائیکل اور اسٹریم ایونٹس خارج کرتی ہے
جب ماڈل سوچتا ہے، اوزار کال کرتا ہے، اور آؤٹ پٹ اسٹریم کرتا ہے۔ یہ دستاویز وضاحت کرتی ہے کہ یہ مستند لوپ
شروع سے آخر تک کیسے جڑی ہوتی ہے۔

## Entry points

- Gateway RPC: `agent` اور `agent.wait`۔
- CLI: `agent` کمانڈ۔

## How it works (high-level)

1. `agent` RPC پیرامیٹرز کی توثیق کرتا ہے، سیشن (sessionKey/sessionId) حل کرتا ہے، سیشن میٹاڈیٹا کو محفوظ کرتا ہے، اور فوراً `{ runId, acceptedAt }` واپس کرتا ہے۔
2. `agentCommand` ایجنٹ کو چلاتا ہے:
   - ماڈل اور thinking/verbose کے ڈیفالٹس حل کرتا ہے
   - Skills اسنیپ شاٹ لوڈ کرتا ہے
   - `runEmbeddedPiAgent` (pi-agent-core runtime) کو کال کرتا ہے
   - اگر ایمبیڈڈ لوپ کوئی ایونٹ خارج نہ کرے تو **lifecycle end/error** خارج کرتا ہے
3. `runEmbeddedPiAgent`:
   - فی سیشن + عالمی قطاروں کے ذریعے رنز کو سلسلہ وار بناتا ہے
   - ماڈل + auth پروفائل حل کرتا ہے اور pi سیشن بناتا ہے
   - pi ایونٹس کو سبسکرائب کرتا ہے اور assistant/tool ڈیلٹاز کو اسٹریم کرتا ہے
   - ٹائم آؤٹ نافذ کرتا ہے → حد سے تجاوز پر رَن کو منسوخ کرتا ہے
   - پے لوڈز + استعمال کی میٹاڈیٹا واپس کرتا ہے
4. `subscribeEmbeddedPiSession`، pi-agent-core ایونٹس کو OpenClaw کے `agent` اسٹریم سے جوڑتا ہے:
   - tool ایونٹس => `stream: "tool"`
   - assistant ڈیلٹاز => `stream: "assistant"`
   - lifecycle ایونٹس => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait`، `waitForAgentJob` استعمال کرتا ہے:
   - `runId` کے لیے **lifecycle end/error** کا انتظار کرتا ہے
   - `{ status: ok|error|timeout, startedAt, endedAt, error? }` واپس کرتا ہے

## Queueing + concurrency

- رنز فی سیشن کلید (session lane) کے لحاظ سے اور اختیاری طور پر ایک عالمی لین کے ذریعے سلسلہ وار کی جاتی ہیں۔
- یہ اوزار/سیشن ریسز کو روکتا ہے اور سیشن ہسٹری کو ہم آہنگ رکھتا ہے۔
- میسجنگ چینلز قطار موڈز (collect/steer/followup) منتخب کر سکتے ہیں جو اس لین سسٹم میں شامل ہوتے ہیں۔
  دیکھیں [Command Queue](/concepts/queue)۔

## Session + workspace preparation

- ورک اسپیس حل اور تخلیق کی جاتی ہے؛ sandboxed رنز sandbox ورک اسپیس روٹ کی طرف ری ڈائریکٹ ہو سکتی ہیں۔
- Skills لوڈ کی جاتی ہیں (یا اسنیپ شاٹ سے دوبارہ استعمال کی جاتی ہیں) اور env اور پرامپٹ میں انجیکٹ کی جاتی ہیں۔
- بوٹ اسٹرپ/سیاق فائلیں حل کی جاتی ہیں اور سسٹم پرامپٹ رپورٹ میں شامل کی جاتی ہیں۔
- سیشن رائٹ لاک حاصل کیا جاتا ہے؛ اسٹریمنگ سے پہلے `SessionManager` کھولا اور تیار کیا جاتا ہے۔

## Prompt assembly + system prompt

- سسٹم پرامپٹ OpenClaw کے بنیادی پرامپٹ، Skills پرامپٹ، بوٹ اسٹرپ سیاق، اور فی رَن اوور رائیڈز سے بنایا جاتا ہے۔
- ماڈل مخصوص حدود اور کمپیکشن ریزرو ٹوکنز نافذ کیے جاتے ہیں۔
- ماڈل کیا دیکھتا ہے اس کے لیے [System prompt](/concepts/system-prompt) دیکھیں۔

## Hook points (where you can intercept)

OpenClaw میں دو hook سسٹمز ہیں:

- **Internal hooks** (Gateway hooks): کمانڈز اور لائف سائیکل ایونٹس کے لیے ایونٹ پر مبنی اسکرپٹس۔
- **Plugin hooks**: ایجنٹ/اوزار لائف سائیکل اور gateway پائپ لائن کے اندر توسیعی نقاط۔

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: سسٹم پرامپٹ کو حتمی شکل دینے سے پہلے بوٹ اسٹرپ فائلیں بناتے وقت چلتا ہے۔
  اسے بوٹ اسٹرپ سیاق فائلیں شامل/حذف کرنے کے لیے استعمال کریں۔
- **Command hooks**: `/new`, `/reset`, `/stop`, اور دیگر کمانڈ ایونٹس (Hooks دستاویز دیکھیں)۔

سیٹ اپ اور مثالوں کے لیے [Hooks](/automation/hooks) دیکھیں۔

### Plugin hooks (agent + gateway lifecycle)

یہ ایجنٹ لوپ یا gateway پائپ لائن کے اندر چلتے ہیں:

- **`before_agent_start`**: رَن شروع ہونے سے پہلے سیاق انجیکٹ کریں یا سسٹم پرامپٹ اوور رائیڈ کریں۔
- **`agent_end`**: تکمیل کے بعد حتمی پیغامات کی فہرست اور رَن میٹاڈیٹا کا معائنہ کریں۔
- **`before_compaction` / `after_compaction`**: کمپیکشن سائیکلز کا مشاہدہ یا تشریح کریں۔
- **`before_tool_call` / `after_tool_call`**: اوزار کے پیرامیٹرز/نتائج کو انٹرسیپٹ کریں۔
- **`tool_result_persist`**: اوزار کے نتائج کو سیشن ٹرانسکرپٹ میں لکھنے سے پہلے ہم زمانی طور پر تبدیل کریں۔
- **`message_received` / `message_sending` / `message_sent`**: اِن باؤنڈ + آؤٹ باؤنڈ پیغام hooks۔
- **`session_start` / `session_end`**: سیشن لائف سائیکل کی سرحدیں۔
- **`gateway_start` / `gateway_stop`**: gateway لائف سائیکل ایونٹس۔

hook API اور رجسٹریشن کی تفصیلات کے لیے [Plugins](/tools/plugin#plugin-hooks) دیکھیں۔

## Streaming + partial replies

- Assistant ڈیلٹاز pi-agent-core سے اسٹریم ہوتے ہیں اور `assistant` ایونٹس کے طور پر خارج کیے جاتے ہیں۔
- بلاک اسٹریمنگ جزوی جوابات `text_end` یا `message_end` پر خارج کر سکتی ہے۔
- Reasoning اسٹریمنگ علیحدہ اسٹریم کے طور پر یا بلاک جوابات کی صورت میں خارج کی جا سکتی ہے۔
- چنکنگ اور بلاک جواب کے رویے کے لیے [Streaming](/concepts/streaming) دیکھیں۔

## Tool execution + messaging tools

- اوزار کے آغاز/اپڈیٹ/اختتام ایونٹس `tool` اسٹریم پر خارج کیے جاتے ہیں۔
- لاگنگ/اخراج سے پہلے اوزار کے نتائج کو سائز اور امیج پے لوڈز کے لیے صاف کیا جاتا ہے۔
- میسجنگ ٹول کی بھیجائیاں دہرے assistant تصدیقی پیغامات کو دبانے کے لیے ٹریک کی جاتی ہیں۔

## Reply shaping + suppression

- حتمی پے لوڈز درج ذیل سے تیار کیے جاتے ہیں:
  - assistant متن (اور اختیاری reasoning)
  - اِن لائن اوزار خلاصے (جب verbose + اجازت یافتہ ہوں)
  - ماڈل کی غلطی کی صورت میں assistant ایرر متن
- `NO_REPLY` کو خاموش ٹوکن سمجھا جاتا ہے اور آؤٹ گوئنگ پے لوڈز سے فلٹر کر دیا جاتا ہے۔
- میسجنگ ٹول کی نقلیں حتمی پے لوڈ فہرست سے ہٹا دی جاتی ہیں۔
- اگر کوئی قابلِ رینڈر پے لوڈ باقی نہ رہے اور اوزار میں خرابی ہو، تو ایک فال بیک ٹول ایرر جواب خارج کیا جاتا ہے
  (جب تک کہ میسجنگ ٹول پہلے ہی صارف کو نظر آنے والا جواب نہ بھیج چکا ہو)۔

## Compaction + retries

- خودکار کمپیکشن `compaction` اسٹریم ایونٹس خارج کرتی ہے اور دوبارہ کوشش کو متحرک کر سکتی ہے۔
- دوبارہ کوشش پر، اِن میموری بفرز اور اوزار خلاصے دہرے آؤٹ پٹ سے بچنے کے لیے ری سیٹ کیے جاتے ہیں۔
- کمپیکشن پائپ لائن کے لیے [Compaction](/concepts/compaction) دیکھیں۔

## Event streams (today)

- `lifecycle`: `subscribeEmbeddedPiSession` کے ذریعے خارج کیا جاتا ہے (اور بطور فال بیک `agentCommand` کے ذریعے)
- `assistant`: pi-agent-core سے اسٹریمڈ ڈیلٹاز
- `tool`: pi-agent-core سے اسٹریمڈ اوزار ایونٹس

## Chat channel handling

- Assistant ڈیلٹاز چیٹ `delta` پیغامات میں بفر کیے جاتے ہیں۔
- **lifecycle end/error** پر ایک چیٹ `final` خارج کیا جاتا ہے۔

## Timeouts

- `agent.wait` ڈیفالٹ: 30s (صرف انتظار)۔ `timeoutMs` پیرامیٹر اوور رائیڈ کرتا ہے۔
- ایجنٹ رَن ٹائم: `agents.defaults.timeoutSeconds` ڈیفالٹ 600s؛ `runEmbeddedPiAgent` ابورٹ ٹائمر میں نافذ۔

## Where things can end early

- ایجنٹ ٹائم آؤٹ (abort)
- AbortSignal (cancel)
- Gateway ڈسکنیکٹ یا RPC ٹائم آؤٹ
- `agent.wait` ٹائم آؤٹ (صرف انتظار، ایجنٹ کو نہیں روکتا)
