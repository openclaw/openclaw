---
summary: "ہدفی ڈیبگ لاگز کے لیے تشخیصی فلیگز"
read_when:
  - "آپ کو عالمی لاگنگ لیولز بڑھائے بغیر ہدفی ڈیبگ لاگز درکار ہوں"
  - "آپ کو سپورٹ کے لیے سب سسٹم مخصوص لاگز حاصل کرنے ہوں"
title: "تشخیصی فلیگز"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:12Z
---

# تشخیصی فلیگز

تشخیصی فلیگز آپ کو ہر جگہ تفصیلی لاگنگ آن کیے بغیر ہدفی ڈیبگ لاگز فعال کرنے دیتے ہیں۔ فلیگز اختیاری (opt-in) ہوتے ہیں اور اس وقت تک کوئی اثر نہیں ڈالتے جب تک کوئی سب سسٹم انہیں چیک نہ کرے۔

## یہ کیسے کام کرتا ہے

- فلیگز اسٹرنگز ہوتے ہیں (حروفِ تہجی کی بڑی/چھوٹی صورت سے غیر حساس)۔
- آپ فلیگز کو کنفیگ میں یا env اووررائیڈ کے ذریعے فعال کر سکتے ہیں۔
- وائلڈکارڈز کی حمایت موجود ہے:
  - `telegram.*`، `telegram.http` سے میچ کرتا ہے
  - `*` تمام فلیگز کو فعال کرتا ہے

## کنفیگ کے ذریعے فعال کریں

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

متعدد فلیگز:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

فلیگز تبدیل کرنے کے بعد گیٹ وے کو ری اسٹارٹ کریں۔

## Env اووررائیڈ (ایک وقتی)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

تمام فلیگز غیر فعال کریں:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## لاگز کہاں جاتے ہیں

فلیگز معیاری تشخیصی لاگ فائل میں لاگز خارج کرتے ہیں۔ بطورِ طے شدہ:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

اگر آپ `logging.file` سیٹ کریں تو اس کے بجائے وہ راستہ استعمال ہوگا۔ لاگز JSONL فارمیٹ میں ہوتے ہیں (ہر لائن میں ایک JSON آبجیکٹ)۔ ریڈیکشن اب بھی `logging.redactSensitive` کی بنیاد پر لاگو رہتی ہے۔

## لاگز نکالیں

تازہ ترین لاگ فائل منتخب کریں:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP تشخیصی لاگز کے لیے فلٹر کریں:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

یا دوبارہ پیدا کرتے ہوئے ٹیل کریں:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

ریموٹ گیٹ ویز کے لیے، آپ `openclaw logs --follow` بھی استعمال کر سکتے ہیں (دیکھیں [/cli/logs](/cli/logs))۔

## نوٹس

- اگر `logging.level`، `warn` سے زیادہ سیٹ ہو تو یہ لاگز دبائے جا سکتے ہیں۔ بطورِ طے شدہ `info` مناسب ہے۔
- فلیگز کو فعال چھوڑنا محفوظ ہے؛ یہ صرف مخصوص سب سسٹم کے لیے لاگ والیوم کو متاثر کرتے ہیں۔
- لاگ کے مقامات، لیولز، اور ریڈیکشن تبدیل کرنے کے لیے [/logging](/logging) استعمال کریں۔
