---
summary: "CLI حوالہ برائے `openclaw health` (RPC کے ذریعے Gateway کی صحت کا اینڈپوائنٹ)"
read_when:
  - آپ چلتے ہوئے Gateway کی صحت کو تیزی سے جانچنا چاہتے ہیں
title: "صحت"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:56Z
---

# `openclaw health`

چلتے ہوئے Gateway سے صحت حاصل کریں۔

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

نوٹس:

- `--verbose` لائیو پروبز چلاتا ہے اور جب متعدد اکاؤنٹس کنفیگر ہوں تو فی اکاؤنٹ ٹائمنگز پرنٹ کرتا ہے۔
- آؤٹ پٹ میں متعدد ایجنٹس کنفیگر ہونے کی صورت میں فی ایجنٹ سیشن اسٹورز شامل ہوتے ہیں۔
