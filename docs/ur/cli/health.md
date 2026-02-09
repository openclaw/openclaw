---
summary: "CLI حوالہ برائے `openclaw health` (RPC کے ذریعے Gateway کی صحت کا اینڈپوائنٹ)"
read_when:
  - آپ چلتے ہوئے Gateway کی صحت کو تیزی سے جانچنا چاہتے ہیں
title: "صحت"
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
