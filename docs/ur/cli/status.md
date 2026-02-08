---
summary: "CLI حوالہ برائے `openclaw status` (تشخیصی معلومات، پروبز، استعمال کے اسنیپ شاٹس)"
read_when:
  - آپ چینل کی صحت اور حالیہ سیشن وصول کنندگان کی فوری تشخیص چاہتے ہوں
  - آپ ڈیبگنگ کے لیے قابلِ پیسٹ “all” اسٹیٹس چاہتے ہوں
title: "اسٹیٹس"
x-i18n:
  source_path: cli/status.md
  source_hash: 2bbf5579c48034fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:06Z
---

# `openclaw status`

چینلز اور سیشنز کے لیے تشخیصی معلومات۔

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

نوٹس:

- `--deep` لائیو پروبز چلاتا ہے (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal)۔
- آؤٹ پٹ میں متعدد ایجنٹس کی کنفیگریشن کی صورت میں فی ایجنٹ سیشن اسٹورز شامل ہوتے ہیں۔
- جائزہ میں Gateway اور نوڈ ہوسٹ سروس کی انسٹال/رن ٹائم اسٹیٹس (جہاں دستیاب ہو) شامل ہوتی ہے۔
- جائزہ میں اپ ڈیٹ چینل اور git SHA (سورس چیک آؤٹس کے لیے) شامل ہوتے ہیں۔
- اپ ڈیٹ کی معلومات جائزہ میں ظاہر ہوتی ہیں؛ اگر کوئی اپ ڈیٹ دستیاب ہو تو اسٹیٹس `openclaw update` چلانے کا اشارہ پرنٹ کرتا ہے (دیکھیے [Updating](/install/updating))۔
