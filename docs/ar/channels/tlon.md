---
summary: "حالة دعم Tlon/Urbit وقدراته وتهيئته"
read_when:
  - العمل على ميزات قناة Tlon/Urbit
title: "Tlon"
---

# Tlon (إضافة)

Tlon هو مُراسِل لامركزي مبني على Urbit. يتصل OpenClaw بسفينة Urbit الخاصة بك ويمكنه
الاستجابة للرسائل الخاصة (DMs) ورسائل الدردشة الجماعية. تتطلب الردود في المجموعات ذكر @ افتراضيًا، ويمكن
تقييدها أكثر عبر قوائم السماح.

الحالة: مدعوم عبر إضافة. الرسائل الخاصة، وذكر المجموعات، والردود ضمن السلاسل، والارتداد إلى وسائط نصية فقط
(إضافة عنوان URL إلى التسمية التوضيحية) مدعومة. التفاعلات، والاستطلاعات، ورفع الوسائط الأصلية غير مدعومة.

## الإضافة المطلوبة

يُشحن Tlon كإضافة ولا يكون مُضمّنًا مع التثبيت الأساسي.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/tlon
```

الاستنساخ المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/tlon
```

التفاصيل: [Plugins](/tools/plugin)

## الإعداد

1. ثبّت إضافة Tlon.
2. اجمع عنوان URL لسفينتك ورمز تسجيل الدخول.
3. هيّئ `channels.tlon`.
4. أعد تشغيل Gateway (البوابة).
5. DM البوت أو ذكره في قناة المجموعة.

التهيئة الدنيا (حساب واحد):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## القنوات الجماعية

الاكتشاف التلقائي مُفعّل افتراضيًا. يمكنك أيضًا تثبيت القنوات يدويًا:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

تعطيل الاكتشاف التلقائي:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## التحكم في الوصول

قائمة السماح للرسائل الخاصة (فارغة = السماح للجميع):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

تفويض المجموعات (مقيّد افتراضيًا):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## أهداف التسليم (CLI/cron)

استخدم هذه مع `openclaw message send` أو تسليم cron:

- رسالة خاصة: `~sampel-palnet` أو `dm/~sampel-palnet`
- مجموعة: `chat/~host-ship/channel` أو `group:~host-ship/channel`

## ملاحظات

- تتطلب الردود في المجموعات ذكرًا (مثل `~your-bot-ship`) للاستجابة.
- الردود ضمن السلاسل: إذا كانت الرسالة الواردة ضمن سلسلة، يرد OpenClaw داخل السلسلة.
- الوسائط: `sendMedia` يرتد إلى نص + عنوان URL (لا يوجد رفع أصلي).
