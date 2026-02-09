---
summary: "حالة دعم بوت Zalo، والقدرات، والتهيئة"
read_when:
  - العمل على ميزات Zalo أو webhooks
title: "Zalo"
---

# Zalo (واجهة برمجة تطبيقات البوت)

الحالة: تجريبية. الرسائل المباشرة فقط؛ المجموعات قادمة قريبًا وفق وثائق Zalo.

## المكوّن الإضافي المطلوب

يأتي Zalo على شكل مكوّن إضافي ولا يكون مضمّنًا مع التثبيت الأساسي.

- التثبيت عبر CLI: `openclaw plugins install @openclaw/zalo`
- أو اختيار **Zalo** أثناء التهيئة الأولية وتأكيد مطالبة التثبيت
- التفاصيل: [Plugins](/tools/plugin)

## الإعداد السريع (للمبتدئين)

1. تثبيت مكوّن Zalo الإضافي:
   - من نسخة المصدر: `openclaw plugins install ./extensions/zalo`
   - من npm (إذا كان منشورًا): `openclaw plugins install @openclaw/zalo`
   - أو اختيار **Zalo** في التهيئة الأولية وتأكيد مطالبة التثبيت
2. تعيين الرمز المميّز:
   - Env: `ZALO_BOT_TOKEN=...`
   - أو التهيئة: `channels.zalo.botToken: "..."`.
3. إعادة تشغيل Gateway (أو إنهاء التهيئة الأولية).
4. الوصول عبر الرسائل المباشرة يكون بالاقتران افتراضيًا؛ وافق على رمز الاقتران عند أول تواصل.

أدنى تهيئة:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## ما هو

Zalo تطبيق مراسلة يركّز على فيتنام؛ وتتيح واجهة برمجة تطبيقات البوت الخاصة به لـ Gateway تشغيل بوت لمحادثات 1:1.
وهو مناسب لدعم المستخدمين أو الإشعارات عندما ترغب في توجيه حتمي للردود عائدًا إلى Zalo.

- قناة Zalo Bot API مملوكة لـ Gateway.
- توجيه حتمي: تعود الردود دائمًا إلى Zalo؛ ولا يختار النموذج القنوات.
- تشترك الرسائل المباشرة في الجلسة الرئيسية للوكيل.
- المجموعات غير مدعومة بعد (تشير وثائق Zalo إلى «قريبًا»).

## الإعداد (المسار السريع)

### 1. إنشاء رمز بوت (منصة Zalo Bot)

1. انتقل إلى [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) وسجّل الدخول.
2. أنشئ بوتًا جديدًا واضبط إعداداته.
3. انسخ رمز البوت (الصيغة: `12345689:abc-xyz`).

### 2) تهيئة الرمز (متغيرات البيئة أو التهيئة)

مثال:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

خيار متغيرات البيئة: `ZALO_BOT_TOKEN=...` (يعمل للحساب الافتراضي فقط).

دعم الحسابات المتعددة: استخدم `channels.zalo.accounts` مع رموز مميّزة لكل حساب وخيار `name` عند الحاجة.

3. أعد تشغيل Gateway. يبدأ Zalo عندما يتم حل الرمز (من البيئة أو التهيئة).
4. الوصول عبر الرسائل المباشرة يكون بالاقتران افتراضيًا. وافق على الرمز عند أول تواصل مع البوت.

## كيفية العمل (السلوك)

- يتم تطبيع الرسائل الواردة إلى غلاف القناة المشتركة مع عناصر نائبة للوسائط.
- تُوجَّه الردود دائمًا إلى محادثة Zalo نفسها.
- الاستقصاء الطويل هو الافتراضي؛ ويتوفر وضع webhook باستخدام `channels.zalo.webhookUrl`.

## القيود

- يتم تقسيم النصوص الصادرة إلى مقاطع بطول 2000 حرف (حد واجهة Zalo).
- تنزيل/رفع الوسائط مقيّد بـ `channels.zalo.mediaMaxMb` (الافتراضي 5).
- البثّ محجوب افتراضيًا لأن حد 2000 حرف يجعل البث أقل فائدة.

## التحكم في الوصول (الرسائل المباشرة)

### الوصول إلى DM

- الافتراضي: `channels.zalo.dmPolicy = "pairing"`. يتلقى المرسلون غير المعروفين رمز اقتران؛ وتُتجاهل الرسائل حتى تتم الموافقة (تنتهي صلاحية الرموز بعد ساعة).
- الموافقة عبر:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- الاقتران هو تبادل الرموز الافتراضي. التفاصيل: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` يقبل معرّفات مستخدم رقمية (لا يتوفر البحث بالاسم).

## الاستقصاء الطويل مقابل webhook

- الافتراضي: الاستقصاء الطويل (لا يتطلب عنوان URL عامًا).
- وضع webhook: عيّن `channels.zalo.webhookUrl` و `channels.zalo.webhookSecret`.
  - يجب أن يكون سر webhook بطول 8–256 حرفًا.
  - يجب أن يستخدم عنوان webhook بروتوكول HTTPS.
  - يرسل Zalo الأحداث مع ترويسة `X-Bot-Api-Secret-Token` للتحقق.
  - يتعامل Gateway HTTP مع طلبات webhook على `channels.zalo.webhookPath` (الافتراضي هو مسار عنوان webhook).

**ملاحظة:** getUpdates (الاستقصاء) و webhook متنافيان حصريًا وفق وثائق واجهة Zalo.

## أنواع الرسائل المدعومة

- **الرسائل النصية**: دعم كامل مع تقسيم 2000 حرف.
- **رسائل الصور**: تنزيل ومعالجة الصور الواردة؛ وإرسال الصور عبر `sendPhoto`.
- **الملصقات**: تُسجّل دون معالجة كاملة (لا يوجد رد من الوكيل).
- **أنواع غير مدعومة**: تُسجّل (مثل الرسائل من مستخدمين محميين).

## القدرات

| الميزة                             | الحالة                                             |
| ---------------------------------- | -------------------------------------------------- |
| الرسائل المباشرة                   | ✅ مدعومة                                           |
| المجموعات                          | ❌ قادمة قريبًا (وفق وثائق Zalo) |
| الوسائط (الصور) | ✅ مدعومة                                           |
| التفاعلات                          | ❌ غير مدعومة                                       |
| Threads                            | ❌ غير مدعومة                                       |
| الاستطلاعات                        | ❌ غير مدعومة                                       |
| الأوامر الأصلية                    | ❌ غير مدعومة                                       |
| البثّ                              | ⚠️ محجوب (حد 2000 حرف)          |

## أهداف الإرسال (CLI/cron)

- استخدم معرّف الدردشة كهدف.
- مثال: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## استكشاف الأخطاء وإصلاحها

**البوت لا يستجيب:**

- تحقّق من صلاحية الرمز: `openclaw channels status --probe`
- تأكّد من أن المرسل مُعتمد (اقتران أو allowFrom)
- افحص سجلات Gateway: `openclaw logs --follow`

**الـ webhook لا يستقبل الأحداث:**

- تأكّد من أن عنوان webhook يستخدم HTTPS
- تحقّق من أن سر الرمز بطول 8–256 حرفًا
- أكّد أن نقطة نهاية HTTP لـ Gateway قابلة للوصول على المسار المهيأ
- تحقق من أن تصويت التحديثات لا يعمل (يستبعد بعضها البعض)

## مرجع التهيئة (Zalo)

التهيئة الكاملة: [Configuration](/gateway/configuration)

خيارات الموفّر:

- `channels.zalo.enabled`: تمكين/تعطيل بدء القناة.
- `channels.zalo.botToken`: رمز البوت من منصة Zalo Bot.
- `channels.zalo.tokenFile`: قراءة الرمز من مسار ملف.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (الافتراضي: الاقتران).
- `channels.zalo.allowFrom`: قائمة السماح للرسائل المباشرة (معرّفات المستخدم). يتطلب `open` وجود `"*"`. سيطلب المعالج معرّفات رقمية.
- `channels.zalo.mediaMaxMb`: حد وسائط الوارد/الصادر (بالميغابايت، الافتراضي 5).
- `channels.zalo.webhookUrl`: تمكين وضع webhook (يتطلب HTTPS).
- `channels.zalo.webhookSecret`: سر webhook (8–256 حرفًا).
- `channels.zalo.webhookPath`: مسار webhook على خادم HTTP لـ Gateway.
- `channels.zalo.proxy`: عنوان proxy لطلبات واجهة البرمجة.

خيارات الحسابات المتعددة:

- `channels.zalo.accounts.<id>.botToken`: رمز مميّز لكل حساب.
- `channels.zalo.accounts.<id>.tokenFile`: ملف الرمز لكل حساب.
- `channels.zalo.accounts.<id>.name`: الاسم المعروض.
- `channels.zalo.accounts.<id>.enabled`: تمكين/تعطيل الحساب.
- `channels.zalo.accounts.<id>.dmPolicy`: سياسة الرسائل المباشرة لكل حساب.
- `channels.zalo.accounts.<id>.allowFrom`: قائمة السماح لكل حساب.
- `channels.zalo.accounts.<id>.webhookUrl`: عنوان webhook لكل حساب.
- `channels.zalo.accounts.<id>.webhookSecret`: سر webhook لكل حساب.
- `channels.zalo.accounts.<id>.webhookPath`: مسار webhook لكل حساب.
- `channels.zalo.accounts.<id>.proxy`: عنوان proxy لكل حساب.
