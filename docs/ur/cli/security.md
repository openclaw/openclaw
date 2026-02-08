---
summary: "CLI کے لیے `openclaw security` کا حوالہ (عام سکیورٹی خامیوں کی آڈٹ اور درستگی)"
read_when:
  - آپ کنفیگ/اسٹیٹ پر فوری سکیورٹی آڈٹ چلانا چاہتے ہوں
  - آپ محفوظ “fix” تجاویز (chmod، ڈیفالٹس کو سخت کرنا) لاگو کرنا چاہتے ہوں
title: "سکیورٹی"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:08Z
---

# `openclaw security`

سکیورٹی کے اوزار (آڈٹ + اختیاری درستگیاں)۔

متعلقہ:

- سکیورٹی گائیڈ: [سکیورٹی](/gateway/security)

## آڈٹ

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

آڈٹ اس وقت تنبیہ کرتا ہے جب متعدد DM ارسال کنندگان ایک ہی مرکزی سیشن شیئر کریں اور مشترکہ اِن باکسز کے لیے **secure DM mode**: `session.dmScope="per-channel-peer"` (یا ملٹی اکاؤنٹ چینلز کے لیے `per-account-channel-peer`) کی سفارش کرتا ہے۔
یہ اس صورت میں بھی خبردار کرتا ہے جب چھوٹے models (`<=300B`) sandboxing کے بغیر اور web/browser tools فعال ہونے کے ساتھ استعمال کیے جائیں۔
