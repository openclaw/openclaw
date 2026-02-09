---
summary: "Gateway + CLI کے ذریعے پول بھیجنا"
read_when:
  - پول سپورٹ شامل یا ترمیم کرتے وقت
  - CLI یا گیٹ وے سے پول بھیجنے کی خرابیوں کا ازالہ کرتے وقت
title: "پولز"
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
- 34. Discord: 2-10 اختیارات، `durationHours` کو 1-768 گھنٹوں کے درمیان محدود کیا جاتا ہے (ڈیفالٹ 24)۔ 35. `maxSelections > 1` ملٹی سلیکٹ کو فعال کرتا ہے؛ Discord سخت انتخابی تعداد کی حمایت نہیں کرتا۔
- 36. MS Teams: Adaptive Card پولز (OpenClaw کے زیرِ انتظام)۔ No native poll API; `durationHours` is ignored.

## Agent tool (Message)

`message` ٹول کو `poll` ایکشن کے ساتھ استعمال کریں (`to`، `pollQuestion`، `pollOption`، اختیاری `pollMulti`، `pollDurationHours`، `channel`)۔

38. نوٹ: Discord میں "بالکل N منتخب کریں" موڈ موجود نہیں؛ `pollMulti` ملٹی سلیکٹ سے میپ ہوتا ہے۔
39. Teams پولز Adaptive Cards کے طور پر رینڈر ہوتے ہیں اور ووٹس ریکارڈ کرنے کے لیے گیٹ وے کا آن لائن رہنا ضروری ہے `~/.openclaw/msteams-polls.json` میں۔
