---
summary: "حالة دعم Nextcloud Talk، والإمكانات، والتهيئة"
read_when:
  - العمل على ميزات قناة Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (ملحق)

الحالة: مدعوم عبر ملحق (بوت Webhook). الرسائل المباشرة، والغرف، والتفاعلات، ورسائل Markdown مدعومة.

## الملحق المطلوب

يأتي Nextcloud Talk على شكل ملحق ولا يكون مضمّنًا مع التثبيت الأساسي.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

الاستنساخ المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

إذا اخترت Nextcloud Talk أثناء الإعداد/التهيئة الأولية وتم اكتشاف استنساخ git،
سيعرض OpenClaw مسار التثبيت المحلي تلقائيًا.

التفاصيل: [الملحقات](/tools/plugin)

## الإعداد السريع (للمبتدئين)

1. ثبّت ملحق Nextcloud Talk.

2. على خادم Nextcloud لديك، أنشئ بوتًا:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. فعِّل البوت في إعدادات الغرفة المستهدفة.

4. هيِّئ OpenClaw:
   - التهيئة: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - أو متغيرات البيئة: `NEXTCLOUD_TALK_BOT_SECRET` (للحساب الافتراضي فقط)

5. أعد تشغيل Gateway (البوابة) (أو أنهِ التهيئة الأولية).

التهيئة الدنيا:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## ملاحظات

- لا يمكن للبوتات بدء رسائل مباشرة. يجب على المستخدم مراسلة البوت أولًا.
- يجب أن يكون عنوان URL الخاص بـ Webhook قابلًا للوصول من Gateway (البوابة)؛ اضبط `webhookPublicUrl` إذا كان خلف وكيل.
- تحميل الوسائط غير مدعوم عبر واجهة برمجة تطبيقات البوت؛ تُرسل الوسائط على شكل عناوين URL.
- لا تميّز حمولة Webhook بين الرسائل المباشرة والغرف؛ اضبط `apiUser` + `apiPassword` لتمكين عمليات البحث حسب نوع الغرفة (وإلا فستُعامل الرسائل المباشرة كغرف).

## التحكم بالوصول (الرسائل المباشرة)

- الافتراضي: `channels.nextcloud-talk.dmPolicy = "pairing"`. يحصل المرسلون غير المعروفين على رمز إقران.
- الموافقة عبر:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- الرسائل المباشرة العامة: `channels.nextcloud-talk.dmPolicy="open"` بالإضافة إلى `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` يطابق مُعرِّفات مستخدمي Nextcloud فقط؛ يتم تجاهل أسماء العرض.

## الغرف (المجموعات)

- الافتراضي: `channels.nextcloud-talk.groupPolicy = "allowlist"` (مقيّد بالذكر).
- أدرج الغرف في قائمة السماح باستخدام `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- للسماح بعدم وجود غرف، اترك قائمة السماح فارغة أو اضبط `channels.nextcloud-talk.groupPolicy="disabled"`.

## الإمكانات

| الميزة           | الحالة         |
| ---------------- | -------------- |
| الرسائل المباشرة | مدعومة         |
| الغرف            | مدعومة         |
| Threads          | غير مدعومة     |
| الوسائط          | عناوين URL فقط |
| التفاعلات        | مدعومة         |
| الأوامر الأصلية  | غير مدعومة     |

## مرجع التهيئة (Nextcloud Talk)

التهيئة الكاملة: [التهيئة](/gateway/configuration)

خيارات الموفّر:

- `channels.nextcloud-talk.enabled`: تمكين/تعطيل بدء القناة.
- `channels.nextcloud-talk.baseUrl`: عنوان URL لمثيل Nextcloud.
- `channels.nextcloud-talk.botSecret`: السر المشترك للبوت.
- `channels.nextcloud-talk.botSecretFile`: مسار ملف السر.
- `channels.nextcloud-talk.apiUser`: مستخدم واجهة برمجة التطبيقات لعمليات البحث عن الغرف (اكتشاف الرسائل المباشرة).
- `channels.nextcloud-talk.apiPassword`: كلمة مرور واجهة برمجة التطبيقات/التطبيق لعمليات البحث عن الغرف.
- `channels.nextcloud-talk.apiPasswordFile`: مسار ملف كلمة مرور واجهة برمجة التطبيقات.
- `channels.nextcloud-talk.webhookPort`: منفذ مستمع Webhook (الافتراضي: 8788).
- `channels.nextcloud-talk.webhookHost`: مضيف Webhook (الافتراضي: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: مسار Webhook (الافتراضي: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: عنوان URL الخاص بـ Webhook القابل للوصول خارجيًا.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: قائمة سماح الرسائل المباشرة (مُعرِّفات المستخدمين). يتطلب `open` وجود `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: قائمة سماح المجموعات (مُعرِّفات المستخدمين).
- `channels.nextcloud-talk.rooms`: إعدادات لكل غرفة وقائمة السماح.
- `channels.nextcloud-talk.historyLimit`: حد محفوظات المجموعات (0 للتعطيل).
- `channels.nextcloud-talk.dmHistoryLimit`: حد محفوظات الرسائل المباشرة (0 للتعطيل).
- `channels.nextcloud-talk.dms`: تجاوزات لكل رسالة مباشرة (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: حجم تقطيع النص الصادر (محارف).
- `channels.nextcloud-talk.chunkMode`: `length` (افتراضي) أو `newline` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التقسيم حسب الطول.
- `channels.nextcloud-talk.blockStreaming`: تعطيل بثّ الكتل لهذه القناة.
- `channels.nextcloud-talk.blockStreamingCoalesce`: ضبط دمج بثّ الكتل.
- `channels.nextcloud-talk.mediaMaxMb`: حد الوسائط الواردة (ميغابايت).
