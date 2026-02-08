---
summary: "CLI کے لیے `openclaw reset` کی حوالہ جاتی دستاویز (مقامی اسٹیٹ/کنفیگ کو ری سیٹ کرنا)"
read_when:
  - آپ CLI کو انسٹال حالت میں رکھتے ہوئے مقامی اسٹیٹ صاف کرنا چاہتے ہوں
  - آپ یہ دیکھنے کے لیے ڈرائی رَن چاہتے ہوں کہ کیا کچھ ہٹایا جائے گا
title: "ری سیٹ"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:00Z
---

# `openclaw reset`

مقامی کنفیگ/اسٹیٹ کو ری سیٹ کریں (CLI انسٹال ہی رہتا ہے)۔

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
