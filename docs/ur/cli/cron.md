---
summary: "CLI حوالہ برائے `openclaw cron` (شیڈول بنانا اور پس منظر میں جابز چلانا)"
read_when:
  - آپ کو شیڈول شدہ جابز اور ویک اپس درکار ہوں
  - آپ cron کی عمل درآمد اور لاگز کی جانچ کر رہے ہوں
title: "cron"
---

# `openclaw cron`

Gateway شیڈیولر کے لیے cron جابز کا نظم کریں۔

متعلقہ:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

مشورہ: مکمل کمانڈ سطح کے لیے `openclaw cron --help` چلائیں۔

Note: isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

Note: one-shot (`--at`) jobs delete after success by default. Use `--keep-after-run` to keep them.

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
