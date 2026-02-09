---
summary: "‏/think + /verbose کے لیے ہدایتی نحو اور یہ ماڈل کی reasoning پر کیسے اثر انداز ہوتے ہیں"
read_when:
  - thinking یا verbose ہدایات کی parsing یا ڈیفالٹس کو ایڈجسٹ کرتے وقت
title: "Thinking Levels"
---

# Thinking Levels (/think directives)

## یہ کیا کرتا ہے

- کسی بھی inbound body میں inline ہدایت: `/t <level>`, `/think:<level>`, یا `/thinking <level>`۔
- Levels (aliases): `off | minimal | low | medium | high | xhigh` (صرف GPT-5.2 + Codex ماڈلز)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (زیادہ سے زیادہ بجٹ)
  - xhigh → “ultrathink+” (صرف GPT-5.2 + Codex ماڈلز)
  - `x-high`, `x_high`, `extra-high`, `extra high`, اور `extra_high` کا نقشہ `xhigh` سے ملتا ہے۔
  - `highest`, `max` کا نقشہ `high` سے ملتا ہے۔
- Provider نوٹس:
  - Z.AI (`zai/*`) صرف بائنری تھنکنگ (`on`/`off`) کو سپورٹ کرتا ہے۔ `off` کے علاوہ کوئی بھی لیول `on` سمجھا جاتا ہے (اور `low` پر میپ کیا جاتا ہے)۔

## Resolution order

1. پیغام پر inline ہدایت (صرف اسی پیغام پر لاگو)۔
2. Session override (ہدایتی-only پیغام بھیج کر سیٹ کیا جاتا ہے)۔
3. Global default (کنفیگ میں `agents.defaults.thinkingDefault`)۔
4. Fallback: reasoning-capable ماڈلز کے لیے low؛ بصورت دیگر off۔

## Session default سیٹ کرنا

- ایسا پیغام بھیجیں جو **صرف** ہدایت پر مشتمل ہو (whitespace کی اجازت ہے)، مثلاً `/think:medium` یا `/t high`۔
- یہ موجودہ session کے لیے برقرار رہتا ہے (بطورِ طے شدہ per-sender)؛ `/think:off` یا session idle reset سے صاف ہو جاتا ہے۔
- تصدیقی جواب بھیجا جاتا ہے (`Thinking level set to high.` / `Thinking disabled.`)۔ اگر لیول غلط ہو (مثلاً `/thinking big`)، تو کمانڈ اشارے کے ساتھ مسترد کر دی جاتی ہے اور سیشن اسٹیٹ بغیر تبدیلی کے رہتی ہے۔
- موجودہ thinking لیول دیکھنے کے لیے بغیر آرگومنٹ `/think` (یا `/think:`) بھیجیں۔

## ایجنٹ کے لحاظ سے اطلاق

- **Embedded Pi**: resolved لیول in-process Pi ایجنٹ runtime کو منتقل کیا جاتا ہے۔

## Verbose directives (/verbose یا /v)

- Levels: `on` (minimal) | `full` | `off` (default)۔
- ہدایتی-only پیغام session verbose کو toggle کرتا ہے اور `Verbose logging enabled.` / `Verbose logging disabled.` کے ساتھ جواب دیتا ہے؛ غلط لیولز پر state بدلے بغیر اشارہ واپس آتا ہے۔
- `/verbose off` ایک واضح session override محفوظ کرتا ہے؛ اسے Sessions UI میں `inherit` منتخب کر کے صاف کریں۔
- Inline ہدایت صرف اسی پیغام پر اثر انداز ہوتی ہے؛ بصورت دیگر session/global ڈیفالٹس لاگو ہوتے ہیں۔
- موجودہ verbose لیول دیکھنے کے لیے بغیر آرگومنٹ `/verbose` (یا `/verbose:`) بھیجیں۔
- جب verbose آن ہو، تو وہ ایجنٹس جو اسٹرکچرڈ ٹول رزلٹس (Pi، دیگر JSON ایجنٹس) بھیجتے ہیں، ہر ٹول کال کو اپنی الگ میٹاڈیٹا-اونلی میسج کے طور پر واپس بھیجتے ہیں، جہاں دستیاب ہو `<emoji> <tool-name>: <arg>` (path/command) کے پری فکس کے ساتھ۔ یہ ٹول خلاصے ہر ٹول کے شروع ہوتے ہی بھیجے جاتے ہیں (الگ ببلز)، نہ کہ اسٹریمنگ ڈیلٹاز کے طور پر۔
- جب verbose `full` ہو، تو مکمل ہونے کے بعد ٹول آؤٹ پٹس بھی فارورڈ کیے جاتے ہیں (الگ ببل، محفوظ لمبائی تک مختصر کیے ہوئے)۔ اگر آپ رن کے دوران `/verbose on|full|off` ٹوگل کریں، تو بعد میں آنے والے ٹول ببلز نئی سیٹنگ کے مطابق ہوں گے۔

## Reasoning visibility (/reasoning)

- Levels: `on|off|stream`۔
- ہدایتی-only پیغام یہ toggle کرتا ہے کہ replies میں thinking blocks دکھائے جائیں یا نہیں۔
- فعال ہونے پر، reasoning **الگ پیغام** کے طور پر `Reasoning:` کے prefix کے ساتھ بھیجی جاتی ہے۔
- `stream` (صرف Telegram): جواب بننے کے دوران reasoning کو Telegram draft bubble میں stream کرتا ہے، پھر reasoning کے بغیر حتمی جواب بھیجتا ہے۔
- Alias: `/reason`۔
- موجودہ reasoning لیول دیکھنے کے لیے بغیر آرگومنٹ `/reasoning` (یا `/reasoning:`) بھیجیں۔

## Related

- Elevated mode کی دستاویزات [Elevated mode](/tools/elevated) میں دستیاب ہیں۔

## Heartbeats

- Heartbeat probe باڈی کنفیگر شدہ heartbeat پرامپٹ ہوتی ہے (ڈیفالٹ: `Read HEARTBEAT.md if it exists (workspace context). 16. Follow it strictly. 17. Do not infer or repeat old tasks from prior chats. 18. If nothing needs attention, reply HEARTBEAT_OK.`)۔ اس پر سختی سے عمل کریں۔ پچھلی چیٹس سے پرانے کاموں کا اندازہ نہ لگائیں اور نہ ہی انہیں دہرائیں۔ اگر کسی چیز پر توجہ کی ضرورت نہ ہو تو HEARTBEAT_OK جواب دیں۔ heartbeat پیغام میں inline ہدایات معمول کے مطابق لاگو ہوتی ہیں (لیکن heartbeats سے سیشن ڈیفالٹس تبدیل کرنے سے گریز کریں)۔
- Heartbeat کی ترسیل ڈیفالٹ طور پر صرف فائنل پے لوڈ تک محدود ہوتی ہے۔ الگ `Reasoning:` پیغام بھی بھیجنے کے لیے (جب دستیاب ہو)، `agents.defaults.heartbeat.includeReasoning: true` یا فی ایجنٹ `agents.list[].heartbeat.includeReasoning: true` سیٹ کریں۔

## Web chat UI

- Web chat thinking selector صفحہ لوڈ ہونے پر inbound session store/config سے session میں محفوظ لیول کی عکاسی کرتا ہے۔
- کوئی اور لیول منتخب کرنے سے صرف اگلے پیغام پر اطلاق ہوتا ہے (`thinkingOnce`)؛ بھیجنے کے بعد selector دوبارہ محفوظ شدہ session لیول پر واپس آ جاتا ہے۔
- Session default تبدیل کرنے کے لیے حسبِ سابق `/think:<level>` ہدایت بھیجیں؛ اگلے reload کے بعد selector اس کی عکاسی کرے گا۔
