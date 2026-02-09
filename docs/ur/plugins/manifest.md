---
summary: "پلگ اِن مینی فیسٹ + JSON اسکیما کی ضروریات (سخت کنفیگ ویلیڈیشن)"
read_when:
  - آپ OpenClaw پلگ اِن بنا رہے ہوں
  - آپ کو پلگ اِن کنفیگ اسکیما فراہم کرنا ہو یا پلگ اِن ویلیڈیشن کی غلطیوں کی ڈیبگنگ کرنی ہو
title: "پلگ اِن مینی فیسٹ"
---

# پلگ اِن مینی فیسٹ (openclaw.plugin.json)

Every plugin **must** ship a `openclaw.plugin.json` file in the **plugin root**.
OpenClaw uses this manifest to validate configuration **without executing plugin
code**. Missing or invalid manifests are treated as plugin errors and block
config validation.

مکمل پلگ اِن سسٹم گائیڈ دیکھیں: [پلگ اِنز](/tools/plugin).

## لازمی فیلڈز

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

لازمی کلیدیں:

- `id` (string): کینونیکل پلگ اِن آئی ڈی۔
- `configSchema` (object): پلگ اِن کنفیگ کے لیے JSON اسکیما (ان لائن)۔

اختیاری کلیدیں:

- `kind` (string): پلگ اِن کی قسم (مثال: `"memory"`)۔
- `channels` (array): اس پلگ اِن کے ذریعے رجسٹر کیے گئے چینل آئی ڈیز (مثال: `["matrix"]`)۔
- `providers` (array): اس پلگ اِن کے ذریعے رجسٹر کیے گئے فراہم کنندہ آئی ڈیز۔
- `skills` (array): لوڈ کیے جانے والے Skills ڈائریکٹریز (پلگ اِن روٹ کے نسبتاً)۔
- `name` (string): پلگ اِن کے لیے ڈسپلے نام۔
- `description` (string): پلگ اِن کا مختصر خلاصہ۔
- `uiHints` (object): UI رینڈرنگ کے لیے کنفیگ فیلڈ لیبلز/پلیس ہولڈرز/حساس فلیگز۔
- `version` (string): پلگ اِن ورژن (اطلاعی)۔

## JSON اسکیما کی ضروریات

- **ہر پلگ اِن کو JSON اسکیما لازماً فراہم کرنا ہوگا**، چاہے وہ کوئی کنفیگ قبول نہ کرتا ہو۔
- خالی اسکیما قابلِ قبول ہے (مثال کے طور پر، `{ "type": "object", "additionalProperties": false }`)۔
- اسکیما کی توثیق کنفیگ کے پڑھنے/لکھنے کے وقت ہوتی ہے، رَن ٹائم پر نہیں۔

## ویلیڈیشن کا برتاؤ

- نامعلوم `channels.*` کلیدیں **غلطیاں** ہیں، الا یہ کہ چینل آئی ڈی کسی پلگ اِن مینی فیسٹ میں درج ہو۔
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`
  must reference **discoverable** plugin ids. Unknown ids are **errors**.
- اگر پلگ اِن انسٹال ہو مگر اس کا مینی فیسٹ یا اسکیما خراب یا غائب ہو،
  تو ویلیڈیشن ناکام ہو جاتی ہے اور Doctor پلگ اِن کی غلطی رپورٹ کرتا ہے۔
- اگر پلگ اِن کنفیگ موجود ہو لیکن پلگ اِن **غیرفعال** ہو،
  تو کنفیگ برقرار رہتا ہے اور Doctor + لاگز میں **انتباہ** دکھایا جاتا ہے۔

## نوٹس

- مینی فیسٹ **تمام پلگ اِنز کے لیے لازم** ہے، بشمول لوکل فائل سسٹم لوڈز۔
- رَن ٹائم اب بھی پلگ اِن ماڈیول کو علیحدہ طور پر لوڈ کرتا ہے؛ مینی فیسٹ صرف
  ڈسکوری + ویلیڈیشن کے لیے ہے۔
- اگر آپ کا پلگ اِن نیٹو ماڈیولز پر انحصار کرتا ہے، تو بلڈ کے مراحل اور کسی بھی
  پیکج-منیجر اجازت فہرست کی ضروریات کی دستاویز کریں (مثال کے طور پر، pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`)۔
