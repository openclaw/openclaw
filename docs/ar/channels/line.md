---
summary: "إعداد وتهيئة واستخدام إضافة LINE Messaging API"
read_when:
  - تريد ربط OpenClaw بـ LINE
  - تحتاج إلى إعداد webhook وبيانات الاعتماد الخاصة بـ LINE
  - تريد خيارات رسائل خاصة بـ LINE
title: LINE
---

# LINE (إضافة)

يتصل LINE بـ OpenClaw عبر LINE Messaging API. تعمل الإضافة كمستقبِل webhook
على الـ Gateway وتستخدم رمز وصول القناة + سرّ القناة للمصادقة.

الحالة: مدعوم عبر إضافة. الرسائل المباشرة، ودردشات المجموعات، والوسائط، والمواقع، ورسائل Flex،
ورسائل القوالب، والردود السريعة مدعومة. ردود الفعل والسلاسل غير مدعومة.

## الإضافة المطلوبة

ثبّت إضافة LINE:

```bash
openclaw plugins install @openclaw/line
```

التشغيل من نسخة محلية (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/line
```

## الإعداد

1. أنشئ حساب LINE Developers وافتح لوحة التحكم:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. أنشئ (أو اختر) موفّرًا وأضِف قناة **Messaging API**.
3. انسخ **Channel access token** و**Channel secret** من إعدادات القناة.
4. فعّل **Use webhook** في إعدادات Messaging API.
5. اضبط عنوان webhook URL على نقطة نهاية الـ Gateway لديك (يتطلب HTTPS):

```
https://gateway-host/line/webhook
```

يستجيب الـ Gateway لعملية التحقق من webhook الخاصة بـ LINE (GET) وللأحداث الواردة (POST).
إذا احتجت مسارًا مخصصًا، فاضبط `channels.line.webhookPath` أو
`channels.line.accounts.<id>.webhookPath` وحدّث عنوان URL وفقًا لذلك.

## التهيئة

التهيئة الدنيا:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

متغيرات البيئة (الحساب الافتراضي فقط):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

ملفات الرمز/السر:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

حسابات متعددة:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## التحكم في الوصول

الرسائل المباشرة تُقترن افتراضيًا. يحصل المرسلون غير المعروفين على رمز اقتران ويتم تجاهل
رسائلهم حتى تتم الموافقة.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

قوائم السماح والسياسات:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: مُعرّفات مستخدمي LINE المسموح بها للرسائل المباشرة
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: مُعرّفات مستخدمي LINE المسموح بها للمجموعات
- تجاوزات لكل مجموعة: `channels.line.groups.<groupId>.allowFrom`

مُعرّفات LINE حساسة لحالة الأحرف. تبدو المُعرّفات الصحيحة كما يلي:

- المستخدم: `U` + 32 محرفًا سداسيًا
- المجموعة: `C` + 32 محرفًا سداسيًا
- الغرفة: `R` + 32 محرفًا سداسيًا

## سلوك الرسائل

- يتم تقسيم النص عند 5000 محرف.
- تُزال تنسيقات Markdown؛ وتُحوَّل كتل الشيفرة والجداول إلى بطاقات Flex عند الإمكان.
- تُخزَّن الاستجابات المتدفقة مؤقتًا؛ ويتلقى LINE كتلًا كاملة مع رسوم متحركة للتحميل أثناء عمل الوكيل.
- تنزيل الوسائط مقيّد بواسطة `channels.line.mediaMaxMb` (الافتراضي 10).

## بيانات القناة (الرسائل الغنية)

استخدم `channelData.line` لإرسال الردود السريعة، والمواقع، وبطاقات Flex، أو
رسائل القوالب.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

تتضمن إضافة LINE أيضًا أمر `/card` لإعدادات مسبقة لرسائل Flex:

```
/card info "Welcome" "Thanks for joining!"
```

## استكشاف الأخطاء وإصلاحها

- **فشل التحقق من webhook:** تأكد من أن عنوان webhook URL يستخدم HTTPS وأن
  `channelSecret` يطابق إعدادات لوحة تحكم LINE.
- **لا توجد أحداث واردة:** تحقّق من أن مسار webhook يطابق `channels.line.webhookPath`
  وأن الـ Gateway قابل للوصول من LINE.
- **أخطاء تنزيل الوسائط:** ارفع قيمة `channels.line.mediaMaxMb` إذا تجاوزت الوسائط
  الحد الافتراضي.
