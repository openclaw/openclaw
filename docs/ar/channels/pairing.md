---
summary: "نظرة عامة على الاقتران: الموافقة على من يمكنه مراسلتك مباشرة + أي العُقد يمكنها الانضمام"
read_when:
  - إعداد التحكم في الوصول إلى الرسائل المباشرة
  - إقران عُقدة iOS/Android جديدة
  - مراجعة الوضع الأمني لـ OpenClaw
title: "الاقتران"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:56Z
---

# الاقتران

«الاقتران» هو خطوة **موافقة المالك** الصريحة في OpenClaw.
ويُستخدم في موضعين:

1. **اقتران الرسائل المباشرة (DM)** (من المسموح له التحدث إلى البوت)
2. **اقتران العُقد** (الأجهزة/العُقد المسموح لها بالانضمام إلى شبكة Gateway)

السياق الأمني: [الأمان](/gateway/security)

## 1) اقتران الرسائل المباشرة (الوصول الوارد إلى الدردشة)

عندما تُهيَّأ قناة بسياسة DM `pairing`، يحصل المُرسِلون غير المعروفين على رمز قصير ولا تتم **معالجة** رسالتهم حتى تقوم بالموافقة.

سياسات DM الافتراضية موثّقة في: [الأمان](/gateway/security)

رموز الاقتران:

- 8 أحرف، أحرف كبيرة، دون أحرف ملتبسة (`0O1I`).
- **تنتهي صلاحيتها بعد ساعة واحدة**. يرسل البوت رسالة الاقتران فقط عند إنشاء طلب جديد (تقريبًا مرة واحدة في الساعة لكل مُرسِل).
- تُحدَّد طلبات اقتران DM المعلّقة افتراضيًا بـ **3 لكل قناة**؛ ويتم تجاهل الطلبات الإضافية حتى تنتهي صلاحية أحدها أو تتم الموافقة عليه.

### الموافقة على مُرسِل

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

القنوات المدعومة: `telegram`، `whatsapp`، `signal`، `imessage`، `discord`، `slack`.

### أين تُحفَظ الحالة

تُخزَّن تحت `~/.openclaw/credentials/`:

- الطلبات المعلّقة: `<channel>-pairing.json`
- مخزن قائمة السماح المعتمدة: `<channel>-allowFrom.json`

تعامل مع هذه العناصر على أنها حسّاسة (فهي تتحكم في الوصول إلى مساعدك).

## 2) اقتران أجهزة العُقد (iOS/Android/macOS/عُقد بدون واجهة)

تتصل العُقد بـ Gateway على أنها **أجهزة** باستخدام `role: node`. ينشئ Gateway
طلب اقتران جهاز يجب الموافقة عليه.

### الموافقة على جهاز عُقدة

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### تخزين حالة اقتران العُقد

تُخزَّن تحت `~/.openclaw/devices/`:

- `pending.json` (قصيرة الأجل؛ تنتهي صلاحية الطلبات المعلّقة)
- `paired.json` (الأجهزة المقترنة + الرموز)

### ملاحظات

- واجهة `node.pair.*` القديمة (CLI: `openclaw nodes pending/approve`) هي
  مخزن اقتران منفصل مملوك للبوابة. ما زالت عُقد WS تتطلب اقتران الأجهزة.

## مستندات ذات صلة

- نموذج الأمان + حقن المطالبات: [الأمان](/gateway/security)
- التحديث الآمن (تشغيل doctor): [التحديث](/install/updating)
- تهيئات القنوات:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (قديم): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
