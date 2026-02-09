---
summary: "Elevated exec موڈ اور /elevated ہدایات"
read_when:
  - Elevated موڈ کی ڈیفالٹس، اجازت فہرستوں، یا سلیش کمانڈ کے رویّے میں تبدیلی کرتے وقت
title: "Elevated موڈ"
---

# Elevated موڈ (/elevated ہدایات)

## یہ کیا کرتا ہے

- `/elevated on` گیٹ وے ہوسٹ پر چلتا ہے اور exec منظوریات برقرار رکھتا ہے (بالکل `/elevated ask` کی طرح)۔
- `/elevated full` گیٹ وے ہوسٹ پر چلتا ہے **اور** exec کو خودکار طور پر منظور کرتا ہے (exec منظوریات کو چھوڑ دیتا ہے)۔
- `/elevated ask` گیٹ وے ہوسٹ پر چلتا ہے مگر exec منظوریات برقرار رکھتا ہے (بالکل `/elevated on` کی طرح)۔
- `on`/`ask` زبردستی `exec.security=full` لاگو نہیں کرتے؛ ترتیب دی گئی سکیورٹی/ask پالیسی بدستور نافذ رہتی ہے۔
- صرف اس وقت رویّہ تبدیل کرتا ہے جب ایجنٹ **sandboxed** ہو (ورنہ exec پہلے ہی ہوسٹ پر چلتا ہے)۔
- ہدایتی صورتیں: `/elevated on|off|ask|full`، `/elev on|off|ask|full`۔
- صرف `on|off|ask|full` قابلِ قبول ہیں؛ اس کے علاوہ ہر چیز اشارہ واپس کرتی ہے اور حالت میں تبدیلی نہیں کرتی۔

## یہ کنٹرول کیا کرتا ہے (اور کیا نہیں)

- **Availability gates**: `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can further restrict elevated per agent (both must allow).
- **فی سیشن حالت**: `/elevated on|off|ask|full` موجودہ سیشن کلید کے لیے elevated سطح مقرر کرتا ہے۔
- **ان لائن ہدایت**: پیغام کے اندر `/elevated on|ask|full` صرف اسی پیغام پر لاگو ہوتا ہے۔
- **Groups**: In group chats, elevated directives are only honored when the agent is mentioned. Command-only messages that bypass mention requirements are treated as mentioned.
- **ہوسٹ پر اجرا**: elevated، `exec` کو گیٹ وے ہوسٹ پر نافذ کرتا ہے؛ `full` بھی `security=full` سیٹ کرتا ہے۔
- **منظوریات**: `full` exec منظوریات کو چھوڑ دیتا ہے؛ `on`/`ask` انہیں تب مانتے ہیں جب allowlist/ask قواعد تقاضا کریں۔
- **غیر sandboxed ایجنٹس**: مقام کے لحاظ سے no-op؛ صرف gating، لاگنگ، اور اسٹیٹس کو متاثر کرتا ہے۔
- **ٹول پالیسی بدستور نافذ**: اگر ٹول پالیسی کے تحت `exec` ممنوع ہو تو elevated استعمال نہیں کیا جا سکتا۔
- **`/exec` سے الگ**: `/exec` مجاز ارسال کنندگان کے لیے فی سیشن ڈیفالٹس کو ایڈجسٹ کرتا ہے اور elevated کی ضرورت نہیں ہوتی۔

## حل ہونے کی ترتیب

1. پیغام پر ان لائن ہدایت (صرف اسی پیغام پر لاگو)۔
2. سیشن اوور رائیڈ (ہدایتی-صرف پیغام بھیج کر سیٹ کیا گیا)۔
3. عالمی ڈیفالٹ (کنفیگ میں `agents.defaults.elevatedDefault`)۔

## سیشن ڈیفالٹ سیٹ کرنا

- ایسا پیغام بھیجیں جو **صرف** ہدایت پر مشتمل ہو (whitespace قابلِ قبول ہے)، مثلاً `/elevated full`۔
- تصدیقی جواب بھیجا جاتا ہے (`Elevated mode set to full...` / `Elevated mode disabled.`)۔
- اگر elevated رسائی غیر فعال ہو یا ارسال کنندہ منظور شدہ اجازت فہرست میں نہ ہو، تو ہدایت قابلِ عمل غلطی کے ساتھ جواب دیتی ہے اور سیشن حالت میں تبدیلی نہیں کرتی۔
- موجودہ elevated سطح دیکھنے کے لیے بغیر کسی آرگیومنٹ کے `/elevated` (یا `/elevated:`) بھیجیں۔

## دستیابی + اجازت فہرستیں

- فیچر گیٹ: `tools.elevated.enabled` (ڈیفالٹ کنفیگ کے ذریعے بند ہو سکتا ہے، چاہے کوڈ سپورٹ کرتا ہو)۔
- ارسال کنندہ اجازت فہرست: `tools.elevated.allowFrom` مع فی فراہم کنندہ اجازت فہرستیں (مثلاً `discord`، `whatsapp`)۔
- فی ایجنٹ گیٹ: `agents.list[].tools.elevated.enabled` (اختیاری؛ صرف مزید پابندی لگا سکتا ہے)۔
- فی ایجنٹ اجازت فہرست: `agents.list[].tools.elevated.allowFrom` (اختیاری؛ سیٹ ہونے پر ارسال کنندہ کو **عالمی + فی ایجنٹ** دونوں اجازت فہرستوں سے میل کھانا لازم ہے)۔
- Discord fallback: if `tools.elevated.allowFrom.discord` is omitted, the `channels.discord.dm.allowFrom` list is used as a fallback. Set `tools.elevated.allowFrom.discord` (even `[]`) to override. Per-agent allowlists do **not** use the fallback.
- تمام گیٹس کا پاس ہونا ضروری ہے؛ بصورتِ دیگر elevated کو غیر دستیاب سمجھا جاتا ہے۔

## لاگنگ + اسٹیٹس

- Elevated exec کالز info لیول پر لاگ کی جاتی ہیں۔
- سیشن اسٹیٹس میں elevated موڈ شامل ہوتا ہے (مثلاً `elevated=ask`، `elevated=full`)۔
