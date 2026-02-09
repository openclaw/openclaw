---
summary: "إعداد بوت Mattermost وتهيئة OpenClaw"
read_when:
  - إعداد Mattermost
  - تصحيح مسارات Mattermost
title: "Mattermost"
---

# Mattermost (مكوّن إضافي)

الحالة: مدعوم عبر مكوّن إضافي (رمز بوت + أحداث WebSocket). القنوات والمجموعات والرسائل الخاصة (DMs) مدعومة.
Mattermost منصة مراسلة للفرق قابلة للاستضافة الذاتية؛ راجع الموقع الرسمي على
[mattermost.com](https://mattermost.com) لتفاصيل المنتج والتنزيلات.

## المكوّن الإضافي المطلوب

يُقدَّم Mattermost كمكوّن إضافي ولا يكون مضمّنًا مع التثبيت الأساسي.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/mattermost
```

الاستنساخ المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/mattermost
```

إذا اخترت Mattermost أثناء التهيئة/الإعداد الأولي وتم اكتشاف استنساخ git،
فسيعرض OpenClaw مسار التثبيت المحلي تلقائيًا.

التفاصيل: [Plugins](/tools/plugin)

## الإعداد السريع

1. تثبيت مكوّن Mattermost الإضافي.
2. إنشاء حساب بوت في Mattermost ونسخ **رمز البوت**.
3. نسخ **عنوان URL الأساسي** لـ Mattermost (على سبيل المثال: `https://chat.example.com`).
4. تهيئة OpenClaw وتشغيل Gateway.

التهيئة الدنيا:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## متغيرات البيئة (الحساب الافتراضي)

اضبط هذه على مضيف Gateway إذا كنت تفضّل استخدام متغيرات البيئة:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

تنطبق متغيرات البيئة فقط على الحساب **الافتراضي** (`default`). يجب على الحسابات الأخرى استخدام قيم التهيئة.

## أوضاع الدردشة

يردّ Mattermost على الرسائل الخاصة تلقائيًا. يتم التحكم في سلوك القنوات بواسطة `chatmode`:

- `oncall` (افتراضي): الرد فقط عند الإشارة @ داخل القنوات.
- `onmessage`: الرد على كل رسالة في القناة.
- `onchar`: الرد عندما تبدأ الرسالة ببادئة مُشغِّل.

مثال تهيئة:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

ملاحظات:

- `onchar` لا يزال يستجيب للإشارات @ الصريحة.
- `channels.mattermost.requireMention` مُراعى في التهيئات القديمة، لكن يُفضَّل `chatmode`.

## التحكم في الوصول (الرسائل المباشرة)

- الافتراضي: `channels.mattermost.dmPolicy = "pairing"` (يحصل المرسلون غير المعروفين على رمز إقران).
- الموافقة عبر:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- الرسائل الخاصة العامة: `channels.mattermost.dmPolicy="open"` بالإضافة إلى `channels.mattermost.allowFrom=["*"]`.

## القنوات (المجموعات)

- الافتراضي: `channels.mattermost.groupPolicy = "allowlist"` (مقيّد بالإشارة).
- السماح لقائمة مرسِلين عبر `channels.mattermost.groupAllowFrom` (معرّفات المستخدمين أو `@username`).
- القنوات المفتوحة: `channels.mattermost.groupPolicy="open"` (مقيّد بالإشارة).

## الأهداف للتسليم الصادر

استخدم صيغ الأهداف هذه مع `openclaw message send` أو مهام cron/الويبهوكات:

- `channel:<id>` لقناة
- `user:<id>` لرسالة خاصة
- `@username` لرسالة خاصة (يتم حلّها عبر واجهة Mattermost البرمجية)

تُعامَل المعرّفات المجردة على أنها قنوات.

## تعدد الحسابات

يدعم Mattermost عدة حسابات ضمن `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## استكشاف الأخطاء وإصلاحها

- عدم وجود ردود في القنوات: تأكّد من أن البوت موجود في القناة وقم بالإشارة إليه (oncall)، أو استخدم بادئة مُشغِّل (onchar)، أو اضبط `chatmode: "onmessage"`.
- أخطاء المصادقة: تحقّق من رمز البوت، وعنوان URL الأساسي، وما إذا كان الحساب مفعّلًا.
- مشكلات تعدد الحسابات: تنطبق متغيرات البيئة فقط على حساب `default`.
