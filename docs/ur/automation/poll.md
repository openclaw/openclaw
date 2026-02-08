---
summary: "Gateway + CLI کے ذریعے پول بھیجنا"
read_when:
  - پول سپورٹ شامل یا ترمیم کرتے وقت
  - CLI یا گیٹ وے سے پول بھیجنے کی خرابیوں کا ازالہ کرتے وقت
title: "پولز"
x-i18n:
  source_path: automation/poll.md
  source_hash: 760339865d27ec40
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:49Z
---

# پولز

## معاون چینلز

- WhatsApp (ویب چینل)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Options:

- `--channel`: `whatsapp` (default)، `discord`، یا `msteams`
- `--poll-multi`: متعدد اختیارات منتخب کرنے کی اجازت دیتا ہے
- `--poll-duration-hours`: صرف Discord (اگر چھوڑ دیا جائے تو بطورِ طے شدہ 24)

## Gateway RPC

Method: `poll`

Params:

- `to` (string، لازم)
- `question` (string، لازم)
- `options` (string[]، لازم)
- `maxSelections` (number، اختیاری)
- `durationHours` (number، اختیاری)
- `channel` (string، اختیاری، default: `whatsapp`)
- `idempotencyKey` (string، لازم)

## چینل کے فرق

- WhatsApp: 2-12 اختیارات، `maxSelections` کو اختیارات کی تعداد کے اندر ہونا لازم ہے، `durationHours` کو نظر انداز کرتا ہے۔
- Discord: 2-10 اختیارات، `durationHours` کو 1-768 گھنٹوں تک محدود کیا جاتا ہے (default 24)۔ `maxSelections > 1` ملٹی سلیکٹ کو فعال کرتا ہے؛ Discord سخت انتخابی تعداد کی حمایت نہیں کرتا۔
- MS Teams: Adaptive Card پولز (OpenClaw کے زیرِ انتظام)۔ کوئی مقامی پول API نہیں؛ `durationHours` کو نظر انداز کیا جاتا ہے۔

## Agent tool (Message)

`message` ٹول کو `poll` ایکشن کے ساتھ استعمال کریں (`to`، `pollQuestion`، `pollOption`، اختیاری `pollMulti`، `pollDurationHours`، `channel`)۔

Note: Discord میں “بالکل N منتخب کریں” موڈ موجود نہیں؛ `pollMulti` ملٹی سلیکٹ سے میپ ہوتا ہے۔
Teams کے پولز Adaptive Cards کے طور پر رینڈر ہوتے ہیں اور ووٹس کو `~/.openclaw/msteams-polls.json` میں ریکارڈ کرنے کے لیے گیٹ وے کا آن لائن رہنا ضروری ہے۔
