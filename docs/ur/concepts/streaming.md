---
summary: "اسٹریمنگ + چنکنگ کا رویہ (بلاک جوابات، ڈرافٹ اسٹریمنگ، حدود)"
read_when:
  - چینلز پر اسٹریمنگ یا چنکنگ کے کام کرنے کے طریقے کی وضاحت کرتے وقت
  - بلاک اسٹریمنگ یا چینل چنکنگ کے رویے میں تبدیلی کرتے وقت
  - دوہرے/ابتدائی بلاک جوابات یا ڈرافٹ اسٹریمنگ کی خرابیوں کی جانچ کرتے وقت
title: "اسٹریمنگ اور چنکنگ"
---

# اسٹریمنگ + چنکنگ

OpenClaw میں “اسٹریمنگ” کی دو الگ تہیں ہیں:

- یہ عام چینل پیغامات ہوتے ہیں (ٹوکن ڈیلٹاز نہیں)۔ آج بیرونی چینل پیغامات میں **حقیقی ٹوکن اسٹریمنگ نہیں** ہے۔
- **ٹوکن نما اسٹریمنگ (صرف Telegram):** تخلیق کے دوران جزوی متن کے ساتھ ایک **ڈرافٹ ببل** کو اپڈیٹ کرتا ہے؛ آخر میں حتمی پیغام بھیجا جاتا ہے۔

Telegram ڈرافٹ اسٹریمنگ واحد جزوی اسٹریمنگ سطح ہے۔ `agents.defaults.blockStreamingChunk`: \`{ minChars, maxChars, breakPreference?

## بلاک اسٹریمنگ (چینل پیغامات)

بلاک اسٹریمنگ اسسٹنٹ کے آؤٹ پٹ کو دستیاب ہوتے ہی موٹے چنکس میں بھیجتی ہے۔

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: ماڈل اسٹریمنگ ایونٹس (نان-اسٹریمنگ ماڈلز کے لیے کم ہو سکتے ہیں)۔
- `chunker`: `EmbeddedBlockChunker` کم/زیادہ حدود اور بریک ترجیح کا اطلاق۔
- `channel send`: اصل آؤٹ باؤنڈ پیغامات (بلاک جوابات)۔

**کنٹرولز:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (بطورِ طے شدہ بند)۔
- چینل اووررائیڈز: `*.blockStreaming` (اور فی اکاؤنٹ ویریئنٹس) تاکہ ہر چینل کے لیے `"on"`/`"off"` کو مجبور کیا جا سکے۔
- `agents.defaults.blockStreamingBreak`: `"text_end"` یا `"message_end"`۔
- }`۔ `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs?
- }\` (بھیجنے سے پہلے اسٹریمنگ بلاکس کو مرج کریں)۔ جب بلاک اسٹریمنگ فعال ہو، OpenClaw بھیجنے سے پہلے **مسلسل بلاک چنکس کو مرج** کر سکتا ہے۔
- چینل ہارڈ کیپ: `*.textChunkLimit` (مثلاً `channels.whatsapp.textChunkLimit`)۔
- چینل چنک موڈ: `*.chunkMode` (`length` بطورِ طے شدہ، `newline` لمبائی کے حساب سے چنکنگ سے پہلے خالی لائنوں (پیراگراف حدود) پر تقسیم کرتا ہے)۔
- Discord سافٹ کیپ: `channels.discord.maxLinesPerMessage` (بطورِ طے شدہ 17) UI کلپنگ سے بچنے کے لیے لمبے جوابات کو تقسیم کرتا ہے۔

**حدی معنویات:**

- `text_end`: جیسے ہی چنکر خارج کرے، بلاکس اسٹریمنگ کریں؛ ہر `text_end` پر فلش کریں۔
- `message_end`: اسسٹنٹ پیغام مکمل ہونے تک انتظار کریں، پھر بفر شدہ آؤٹ پٹ فلش کریں۔

`message_end` پھر بھی چنکر استعمال کرتا ہے اگر بفر شدہ متن `maxChars` سے بڑھ جائے، اس لیے آخر میں متعدد چنکس خارج ہو سکتے ہیں۔

## چنکنگ الگورتھم (کم/زیادہ حدود)

بلاک چنکنگ `EmbeddedBlockChunker` کے ذریعے نافذ کی جاتی ہے:

- **کم حد:** جب تک بفر >= `minChars` نہ ہو، خارج نہ کریں (جبراً نہ ہو تو)۔
- **زیادہ حد:** `maxChars` سے پہلے تقسیم کو ترجیح دیں؛ اگر مجبور ہوں تو `maxChars` پر تقسیم کریں۔
- **بریک ترجیح:** `paragraph` → `newline` → `sentence` → `whitespace` → سخت بریک۔
- **کوڈ فینسز:** فینسز کے اندر کبھی تقسیم نہ کریں؛ جب `maxChars` پر مجبور ہوں تو مارک ڈاؤن درست رکھنے کے لیے فینس بند + دوبارہ کھولیں۔

`maxChars` کو چینل `textChunkLimit` تک محدود کیا جاتا ہے، اس لیے فی چینل کیپس سے تجاوز ممکن نہیں۔

## کوالسنگ (اسٹریمنگ شدہ بلاکس کو ضم کرنا)

یہ “سنگل لائن اسپام” کم کرتا ہے جبکہ
ترقی پسند آؤٹ پٹ فراہم کرتا رہتا ہے۔ جب بلاک اسٹریمنگ فعال ہو، آپ بلاک جوابات کے درمیان (پہلے بلاک کے بعد) ایک **بے ترتیب وقفہ** شامل کر سکتے ہیں۔

- کوالسنگ **آئیڈل گیپس** (`idleMs`) کا انتظار کرتی ہے، پھر فلش کرتی ہے۔
- بفرز `maxChars` سے محدود ہیں اور حد سے بڑھنے پر فلش ہو جائیں گے۔
- `minChars` چھوٹے ٹکڑوں کو تب تک بھیجنے سے روکتا ہے جب تک کافی متن جمع نہ ہو جائے
  (حتمی فلش ہمیشہ باقی متن بھیج دیتا ہے)۔
- جوائنر `blockStreamingChunk.breakPreference` سے اخذ کیا جاتا ہے
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → اسپیس)۔
- چینل اووررائیڈز `*.blockStreamingCoalesce` کے ذریعے دستیاب ہیں (بشمول فی اکاؤنٹ کنفیگز)۔
- ڈیفالٹ کوالس `minChars` Signal/Slack/Discord کے لیے 1500 تک بڑھا دیا جاتا ہے جب تک اووررائیڈ نہ کیا جائے۔

## بلاکس کے درمیان انسان نما رفتار

یہ ملٹی-ببل جوابات کو
زیادہ قدرتی محسوس کراتا ہے۔ **اسٹریم چنکس:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (جیسے جیسے جائیں خارج کریں)۔

- کنفیگ: `agents.defaults.humanDelay` (ایجنٹ کے لحاظ سے `agents.list[].humanDelay` کے ذریعے اووررائیڈ)۔
- موڈز: `off` (بطورِ طے شدہ)، `natural` (800–2500ms)، `custom` (`minMs`/`maxMs`)۔
- اطلاق صرف **بلاک جوابات** پر ہوتا ہے، حتمی جوابات یا ٹول سمریز پر نہیں۔

## “چنکس اسٹریمنگ کریں یا سب کچھ”

یہ اس سے میپ ہوتا ہے:

- غیر-Telegram چینلز کو بھی `*.blockStreaming: true` درکار ہوتا ہے۔ Non-Telegram channels also need `*.blockStreaming: true`.
- **آخر میں سب کچھ اسٹریمنگ کریں:** `blockStreamingBreak: "message_end"` (ایک بار فلش، اگر بہت لمبا ہو تو متعدد چنکس ممکن)۔
- **کوئی بلاک اسٹریمنگ نہیں:** `blockStreamingDefault: "off"` (صرف حتمی جواب)۔

1. **چینل نوٹ:** غیر‑Telegram چینلز کے لیے، بلاک اسٹریمنگ **بند** رہتی ہے **جب تک کہ**
   `*.blockStreaming` کو واضح طور پر `true` پر سیٹ نہ کیا جائے۔ 2. Telegram بلاک جوابات کے بغیر ڈرافٹس اسٹریم کر سکتا ہے
   (`channels.telegram.streamMode`)۔

کنفیگ لوکیشن یاد دہانی: `blockStreaming*` کے ڈیفالٹس
`agents.defaults` کے تحت ہوتے ہیں، روٹ کنفیگ میں نہیں۔

## Telegram ڈرافٹ اسٹریمنگ (ٹوکن نما)

Telegram واحد چینل ہے جس میں ڈرافٹ اسٹریمنگ ہے:

- Bot API `sendMessageDraft` استعمال کرتا ہے **ٹاپکس والے پرائیویٹ چیٹس** میں۔
- `channels.telegram.streamMode: "partial" | "block" | "off"`۔
  - `partial`: تازہ ترین اسٹریمنگ متن کے ساتھ ڈرافٹ اپڈیٹس۔
  - `block`: چنک شدہ بلاکس میں ڈرافٹ اپڈیٹس (وہی چنکر قواعد)۔
  - `off`: کوئی ڈرافٹ اسٹریمنگ نہیں۔
- ڈرافٹ چنک کنفیگ (صرف `streamMode: "block"` کے لیے): `channels.telegram.draftChunk` (ڈیفالٹس: `minChars: 200`, `maxChars: 800`)۔
- ڈرافٹ اسٹریمنگ بلاک اسٹریمنگ سے الگ ہے؛ بلاک جوابات بطورِ طے شدہ بند ہوتے ہیں اور غیر-Telegram چینلز پر صرف `*.blockStreaming: true` کے ذریعے فعال کیے جاتے ہیں۔
- حتمی جواب پھر بھی ایک عام پیغام ہوتا ہے۔
- `/reasoning stream` استدلال کو ڈرافٹ ببل میں لکھتا ہے (صرف Telegram)۔

جب ڈرافٹ اسٹریمنگ فعال ہو، OpenClaw اس جواب کے لیے بلاک اسٹریمنگ غیر فعال کر دیتا ہے تاکہ ڈبل اسٹریمنگ سے بچا جا سکے۔

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram ڈرافٹ ببل (حقیقی پیغام نہیں)۔
- `final reply`: عام Telegram پیغام بھیجنا۔
