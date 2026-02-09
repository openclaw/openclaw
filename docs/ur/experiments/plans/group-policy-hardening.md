---
summary: "Telegram اجازت فہرست کی سختی: سابقہ + خالی جگہوں کی نارملائزیشن"
read_when:
  - Telegram اجازت فہرست میں تاریخی تبدیلیوں کا جائزہ لیتے وقت
title: "Telegram اجازت فہرست کی سختی"
---

# Telegram اجازت فہرست کی سختی

**تاریخ**: 2026-01-05  
**حیثیت**: مکمل  
**PR**: #216

## خلاصہ

Telegram allowlists اب `telegram:` اور `tg:` prefixes کو case-insensitive طور پر قبول کرتے ہیں، اور
غیر ارادی whitespace کو بھی برداشت کرتے ہیں۔ یہ inbound allowlist چیکس کو outbound send normalization کے ساتھ ہم آہنگ کرتا ہے۔

## کیا بدلا

- سابقات `telegram:` اور `tg:` کو ایک ہی سمجھا جاتا ہے (حروفِ تہجی کی تمیز کے بغیر)۔
- اجازت فہرست کی اندراجات کو تراشا جاتا ہے؛ خالی اندراجات کو نظرانداز کیا جاتا ہے۔

## مثالیں

یہ سب ایک ہی ID کے لیے قبول کیے جاتے ہیں:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## یہ کیوں اہم ہے

لاگز یا چیٹ IDs سے کاپی/پیسٹ میں اکثر prefixes اور whitespace شامل ہوتا ہے۔ Normalization اس بات کا تعین کرتے وقت
false negatives سے بچاتا ہے کہ DMs یا گروپس میں جواب دینا ہے یا نہیں۔

## متعلقہ دستاویزات

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
