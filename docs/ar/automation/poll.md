---
summary: "إرسال الاستطلاعات عبر Gateway + CLI"
read_when:
  - إضافة دعم الاستطلاعات أو تعديله
  - تصحيح أخطاء إرسال الاستطلاعات من CLI أو Gateway
title: "الاستطلاعات"
---

# الاستطلاعات

## القنوات المدعومة

- WhatsApp (قناة الويب)
- Discord
- MS Teams (بطاقات تكيّفية)

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

الخيارات:

- `--channel`: `whatsapp` (افتراضيًا)، `discord`، أو `msteams`
- `--poll-multi`: السماح بتحديد خيارات متعددة
- `--poll-duration-hours`: خاص بـ Discord (الافتراضي 24 عند الإهمال)

## Gateway RPC

الطريقة: `poll`

Params:

- `to` (string، مطلوب)
- `question` (string، مطلوب)
- `options` (string[]، مطلوب)
- `maxSelections` (number، اختياري)
- `durationHours` (number، اختياري)
- `channel` (string، اختياري، الافتراضي: `whatsapp`)
- `idempotencyKey` (string، مطلوب)

## اختلافات القنوات

- WhatsApp: من 2 إلى 12 خيارًا، يجب أن يكون `maxSelections` ضمن عدد الخيارات، ويتجاهل `durationHours`.
- Discord: من 2 إلى 10 خيارات، يتم تقييد `durationHours` بين 1 و768 ساعة (الافتراضي 24). يفعّل `maxSelections > 1` التحديد المتعدد؛ ولا يدعم Discord عددًا صارمًا للتحديد.
- MS Teams: استطلاعات بطاقات تكيّفية (تدار بواسطة OpenClaw). لا توجد واجهة برمجة تطبيقات أصلية للاستطلاعات؛ يتم تجاهل `durationHours`.

## أداة الوكيل (الرسالة)

استخدم أداة `message` مع إجراء `poll` (`to`، `pollQuestion`، `pollOption`، واختياريًا `pollMulti`، `pollDurationHours`، `channel`).

ملاحظة: لا يوفّر Discord وضع «اختيار عدد محدد N»؛ إذ يتم ربط `pollMulti` بالتحديد المتعدد.
تُعرَض استطلاعات Teams كبطاقات تكيّفية وتتطلب بقاء Gateway متصلًا
لتسجيل الأصوات في `~/.openclaw/msteams-polls.json`.
