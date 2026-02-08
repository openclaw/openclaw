---
summary: "CLI حوالہ برائے `openclaw cron` (شیڈول بنانا اور پس منظر میں جابز چلانا)"
read_when:
  - آپ کو شیڈول شدہ جابز اور ویک اپس درکار ہوں
  - آپ cron کی عمل درآمد اور لاگز کی جانچ کر رہے ہوں
title: "cron"
x-i18n:
  source_path: cli/cron.md
  source_hash: 09982d6dd1036a56
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:56Z
---

# `openclaw cron`

Gateway شیڈیولر کے لیے cron جابز کا نظم کریں۔

متعلقہ:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

مشورہ: مکمل کمانڈ سطح کے لیے `openclaw cron --help` چلائیں۔

نوٹ: علیحدہ `cron add` جابز بطورِ طے شدہ `--announce` ڈیلیوری استعمال کرتی ہیں۔ آؤٹ پٹ کو اندرونی رکھنے کے لیے `--no-deliver` استعمال کریں۔ `--deliver`، `--announce` کے لیے بطور متروک عرف باقی ہے۔

نوٹ: ایک مرتبہ چلنے والی (`--at`) جابز کامیابی کے بعد بطورِ طے شدہ حذف ہو جاتی ہیں۔ انہیں برقرار رکھنے کے لیے `--keep-after-run` استعمال کریں۔

نوٹ: بار بار چلنے والی جابز اب مسلسل غلطیوں کے بعد ایکسپونینشل ری ٹرائی بیک آف استعمال کرتی ہیں (30s → 1m → 5m → 15m → 60m)، پھر اگلی کامیاب رن کے بعد معمول کے شیڈول پر واپس آ جاتی ہیں۔

## Common edits

پیغام بدلے بغیر ڈیلیوری کی ترتیبات اپڈیٹ کریں:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

علیحدہ جاب کے لیے ڈیلیوری غیر فعال کریں:

```bash
openclaw cron edit <job-id> --no-deliver
```

کسی مخصوص چینل میں اعلان کریں:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
