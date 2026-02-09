---
summary: "سلوك البثّ + التجزئة (ردود الكتل، بثّ المسودات، الحدود)"
read_when:
  - شرح كيفية عمل البثّ أو التجزئة على القنوات
  - تغيير سلوك بثّ الكتل أو تجزئة القنوات
  - تصحيح أخطاء تكرار ردود الكتل أو إرسالها مبكرًا أو بثّ المسودات
title: "البث و القطع"
---

# البثّ + التجزئة

يحتوي OpenClaw على طبقتين منفصلتين من «البثّ»:

- **بثّ الكتل (القنوات):** إرسال **كتل** مكتملة مع كتابة المساعد. هذه رسائل قناة عادية (وليست دلتا رموز).
- **بثّ شبيه بالرموز (Telegram فقط):** تحديث **فقاعة مسودة** بنص جزئي أثناء التوليد؛ ويتم إرسال الرسالة النهائية في النهاية.

لا يوجد اليوم **بثّ حقيقي للرموز** إلى رسائل القنوات الخارجية. بثّ مسودات Telegram هو سطح البثّ الجزئي الوحيد.

## بثّ الكتل (رسائل القنوات)

يرسل بثّ الكتل مخرجات المساعد على شكل مقاطع كبيرة نسبيًا كلما أصبحت متاحة.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

اسطوري:

- `text_delta/events`: أحداث بثّ النموذج (قد تكون متباعدة في النماذج غير الداعمة للبثّ).
- `chunker`: `EmbeddedBlockChunker` مع تطبيق الحدود الدنيا/العليا + تفضيل موضع الفصل.
- `channel send`: الرسائل الصادرة الفعلية (ردود الكتل).

**عناصر التحكّم:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (معطّل افتراضيًا).
- تجاوزات القناة: `*.blockStreaming` (ومثيلاتها لكل حساب) لفرض `"on"`/`"off"` لكل قناة.
- `agents.defaults.blockStreamingBreak`: `"text_end"` أو `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (دمج الكتل المبثوثة قبل الإرسال).
- الحدّ الصارم للقناة: `*.textChunkLimit` (مثل `channels.whatsapp.textChunkLimit`).
- وضع تجزئة القناة: `*.chunkMode` (الافتراضي `length`، و`newline` يفصل عند الأسطر الفارغة «حدود الفقرات» قبل التجزئة حسب الطول).
- الحدّ اللين لـ Discord: `channels.discord.maxLinesPerMessage` (الافتراضي 17) يقسّم الردود الطويلة لتجنّب اقتطاع الواجهة.

**دلالات الحدود:**

- `text_end`: بثّ الكتل فور أن يُصدر المُجزِّئ مقطعًا؛ التفريغ عند كل `text_end`.
- `message_end`: الانتظار حتى تنتهي رسالة المساعد، ثم تفريغ المخرجات المخزّنة.

لا يزال `message_end` يستخدم المُجزِّئ إذا تجاوز النص المخزّن `maxChars`، لذا قد يُصدر عدة مقاطع في النهاية.

## خوارزمية القطع (حدود منخفضة/مرتفعة)

تُنفَّذ تجزئة الكتل بواسطة `EmbeddedBlockChunker`:

- **الحدّ الأدنى:** لا تُصدر مقطعًا حتى يصل المخزن إلى >= `minChars` (إلا إذا فُرض الإصدار).
- **الحدّ الأعلى:** تفضيل الفصل قبل `maxChars`؛ وإذا فُرض، فالفصل عند `maxChars`.
- **تفضيل موضع الفصل:** `paragraph` → `newline` → `sentence` → `whitespace` → فصل قاسٍ.
- **أسوار الشيفرة:** لا يتم الفصل داخل الأسوار مطلقًا؛ وعند الاضطرار عند `maxChars`، يتم إغلاق السور ثم إعادة فتحه للحفاظ على صحة Markdown.

يتم تقييد `maxChars` بحدّ القناة `textChunkLimit`، لذا لا يمكن تجاوز حدود كل قناة.

## الدمج (دمج الكتل المبثوثة)

عند تمكين بثّ الكتل، يمكن لـ OpenClaw **دمج مقاطع الكتل المتتالية**
قبل إرسالها. يقلّل ذلك «الرسائل أحادية السطر» مع الاستمرار في توفير
مخرجات تدريجية.

- ينتظر الدمج **فجوات خمول** (`idleMs`) قبل التفريغ.
- تُقيَّد المخازن بـ `maxChars` وسيتم تفريغها إذا تجاوزته.
- يمنع `minChars` إرسال الشذرات الصغيرة حتى يتراكم نص كافٍ
  (والتفريغ النهائي يرسل دائمًا النص المتبقي).
- يُشتقّ رابط الدمج من `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`، `newline` → `\n`، `sentence` → مسافة).
- تتوفر تجاوزات القناة عبر `*.blockStreamingCoalesce` (بما في ذلك تهيئات لكل حساب).
- القيمة الافتراضية لدمج `minChars` تُرفع إلى 1500 في Signal/Slack/Discord ما لم يتم تجاوزها.

## إيقاع شبيه بالبشر بين الكتل

عند تمكين بثّ الكتل، يمكنك إضافة **توقّف عشوائي** بين
ردود الكتل (بعد الكتلة الأولى). يجعل ذلك الاستجابات متعددة الفقاعات أكثر طبيعية.

- التهيئة: `agents.defaults.humanDelay` (التجاوز لكل وكيل عبر `agents.list[].humanDelay`).
- الأوضاع: `off` (افتراضي)، `natural` (800–2500 مللي ثانية)، `custom` (`minMs`/`maxMs`).
- ينطبق فقط على **ردود الكتل**، وليس الردود النهائية أو ملخصات الأدوات.

## «بثّ المقاطع أم كل شيء»

هذه الخرائط إلى:

- **بثّ المقاطع:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (الإصدار أثناء التوليد). تحتاج القنوات غير Telegram أيضًا إلى `*.blockStreaming: true`.
- **بثّ كل شيء في النهاية:** `blockStreamingBreak: "message_end"` (تفريغ واحد، وربما عدة مقاطع إذا كان الطول كبيرًا جدًا).
- **بدون بثّ كتل:** `blockStreamingDefault: "off"` (الرد النهائي فقط).

**ملاحظة القناة:** بالنسبة للقنوات غير Telegram، يكون بثّ الكتل **معطّلًا ما لم**
يتم تعيين `*.blockStreaming` صراحةً إلى `true`. يمكن لـ Telegram بثّ المسودات
(`channels.telegram.streamMode`) دون ردود كتل.

تذكير بموقع التهيئة: توجد القيم الافتراضية لـ `blockStreaming*` ضمن
`agents.defaults`، وليس في جذر التهيئة.

## بثّ مسودة Telegram (شبيه بالرموز)

Telegram هو القناة الوحيدة التي تدعم بثّ المسودات:

- يستخدم Bot API `sendMessageDraft` في **المحادثات الخاصة مع المواضيع**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: تحديثات المسودة بأحدث نص بثّ.
  - `block`: تحديثات المسودة على شكل كتل مُجزّأة (قواعد المُجزِّئ نفسها).
  - `off`: بدون بثّ مسودة.
- تهيئة تجزئة المسودة (فقط لـ `streamMode: "block"`): `channels.telegram.draftChunk` (الافتراضيات: `minChars: 200`، `maxChars: 800`).
- بثّ المسودة منفصل عن بثّ الكتل؛ ردود الكتل معطّلة افتراضيًا ولا تُفعَّل إلا عبر `*.blockStreaming: true` على القنوات غير Telegram.
- الرد النهائي يظل رسالة عادية.
- يقوم `/reasoning stream` بكتابة الاستدلال داخل فقاعة المسودة (Telegram فقط).

عند تفعيل بثّ المسودة، يقوم OpenClaw بتعطيل بثّ الكتل لذلك الرد لتجنّب البثّ المزدوج.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

اسطوري:

- `sendMessageDraft`: فقاعة مسودة Telegram (ليست رسالة حقيقية).
- `final reply`: إرسال رسالة Telegram عادية.
