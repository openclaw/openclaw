---
summary: "حالة دعم Matrix، والإمكانات، والتهيئة"
read_when:
  - العمل على ميزات قناة Matrix
title: "Matrix"
---

# Matrix (إضافة)

Matrix بروتوكول مراسلة مفتوح ولا مركزي. يتصل OpenClaw بصفته **مستخدمًا** في Matrix
على أي خادم منزلي (homeserver)، لذا تحتاج إلى حساب Matrix للبوت. بعد تسجيل الدخول،
يمكنك مراسلة البوت مباشرةً (DM) أو دعوته إلى الغرف (Matrix «مجموعات»). يُعد Beeper
خيار عميل صالحًا أيضًا، لكنه يتطلب تفعيل E2EE.

الحالة: مدعوم عبر إضافة (@vector-im/matrix-bot-sdk). الرسائل المباشرة، الغرف، السلاسل (threads)، الوسائط، التفاعلات،
الاستطلاعات (إرسال + بدء الاستطلاع كنص)، الموقع، وE2EE (مع دعم التشفير).

## الإضافة المطلوبة

يأتي Matrix كإضافة ولا يكون مضمّنًا مع التثبيت الأساسي.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/matrix
```

نسخة محلية (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/matrix
```

إذا اخترت Matrix أثناء التهيئة/التهيئة الأولية وتم اكتشاف نسخة git محلية،
فسيعرض OpenClaw مسار التثبيت المحلي تلقائيًا.

التفاصيل: [Plugins](/tools/plugin)

## الإعداد

1. تثبيت إضافة Matrix:
   - من npm: `openclaw plugins install @openclaw/matrix`
   - من نسخة محلية: `openclaw plugins install ./extensions/matrix`

2. إنشاء حساب Matrix على خادم منزلي:
   - تصفّح خيارات الاستضافة على [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - أو استضِفه بنفسك.

3. الحصول على رمز وصول لحساب البوت:

   - استخدم واجهة تسجيل الدخول في Matrix مع `curl` على خادمك المنزلي:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - استبدل `matrix.example.org` بعنوان خادمك المنزلي.
   - أو اضبط `channels.matrix.userId` + `channels.matrix.password`: يستدعي OpenClaw نقطة تسجيل الدخول نفسها،
     ويخزّن رمز الوصول في `~/.openclaw/credentials/matrix/credentials.json`،
     ويعيد استخدامه عند التشغيل التالي.

4. تهيئة بيانات الاعتماد:
   - متغيرات البيئة: `MATRIX_HOMESERVER`، `MATRIX_ACCESS_TOKEN` (أو `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - أو في التهيئة: `channels.matrix.*`
   - إذا تم تعيين التهيئة تكون لها الأسبقية.
   - عند استخدام رمز الوصول: يتم جلب معرّف المستخدم تلقائيًا عبر `/whoami`.
   - عند التعيين، يجب أن يكون `channels.matrix.userId` هو معرّف Matrix الكامل (مثال: `@bot:example.org`).

5. أعد تشغيل Gateway (أو أكمل التهيئة الأولية).

6. ابدأ رسالة مباشرة مع البوت أو ادعه إلى غرفة من أي عميل Matrix
   (Element، Beeper، إلخ؛ انظر [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). يتطلب Beeper تفعيل E2EE،
   لذا اضبط `channels.matrix.encryption: true` وتحقق من الجهاز.

أدنى تهيئة (رمز وصول، جلب معرّف المستخدم تلقائيًا):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

تهيئة E2EE (تفعيل التشفير من الطرف إلى الطرف):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## التشفير (E2EE)

التشفير من الطرف إلى الطرف **مدعوم** عبر SDK التشفير بلغة Rust.

فعِّله باستخدام `channels.matrix.encryption: true`:

- إذا تم تحميل وحدة التشفير، فسيتم فك تشفير الغرف المشفّرة تلقائيًا.
- تُشفَّر الوسائط الصادرة عند الإرسال إلى غرف مشفّرة.
- عند الاتصال الأول، يطلب OpenClaw التحقق من الجهاز من جلساتك الأخرى.
- تحقّق من الجهاز في عميل Matrix آخر (Element، إلخ) لتمكين مشاركة المفاتيح. لتمكين مشاركة المفتاح.
- إذا تعذّر تحميل وحدة التشفير، يتم تعطيل E2EE ولن يتم فك تشفير الغرف المشفّرة؛
  ويسجّل OpenClaw تحذيرًا.
- إذا رأيت أخطاء وحدة تشفير مفقودة (على سبيل المثال، `@matrix-org/matrix-sdk-crypto-nodejs-*`)،
  فاسمح بنصوص البناء لـ `@matrix-org/matrix-sdk-crypto-nodejs` وشغّل
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` أو اجلب الثنائي باستخدام
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

تُخزَّن حالة التشفير لكل حساب + رمز وصول في
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(قاعدة بيانات SQLite). وتوجد حالة المزامنة بجانبها في `bot-storage.json`.
إذا تغيّر رمز الوصول (الجهاز)، يتم إنشاء مخزن جديد ويجب
إعادة التحقق من البوت للغرف المشفّرة.

**التحقق من الجهاز:**
عند تفعيل E2EE، سيطلب البوت التحقق من جلساتك الأخرى عند بدء التشغيل.
افتح Element (أو عميلًا آخر) ووافق على طلب التحقق لإرساء الثقة.
بعد التحقق، يمكن للبوت فك تشفير الرسائل في الغرف المشفّرة.

## نموذج التوجيه

- تعود الردود دائمًا إلى Matrix.
- تشارك الرسائل المباشرة جلسة الوكيل الرئيسية؛ بينما تُطابِق الغرف جلسات جماعية.

## التحكم في الوصول (الرسائل المباشرة)

- الافتراضي: `channels.matrix.dm.policy = "pairing"`. يحصل المرسلون غير المعروفين على رمز إقران.
- الموافقة عبر:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- الرسائل المباشرة العامة: `channels.matrix.dm.policy="open"` بالإضافة إلى `channels.matrix.dm.allowFrom=["*"]`.
- يقبل `channels.matrix.dm.allowFrom` معرّفات مستخدم Matrix الكاملة (مثال: `@user:server`). يحلّ معالج الإعداد أسماء العرض إلى معرّفات مستخدم عندما يجد بحث الدليل تطابقًا واحدًا دقيقًا.

## الغرف (المجموعات)

- الافتراضي: `channels.matrix.groupPolicy = "allowlist"` (مقيّد بالذكر). استخدم `channels.defaults.groupPolicy` لتجاوز الافتراضي عند عدم التعيين.
- اسمح بالغرف عبر قائمة السماح باستخدام `channels.matrix.groups` (معرّفات الغرف أو الأسماء المستعارة؛ تُحلّ الأسماء إلى معرّفات عندما يجد بحث الدليل تطابقًا واحدًا دقيقًا):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- يفعّل `requireMention: false` الردّ التلقائي في تلك الغرفة.
- يمكن لـ `groups."*"` تعيين افتراضيات لتقييد الذكر عبر الغرف.
- يقيّد `groupAllowFrom` المرسلين القادرين على تشغيل البوت في الغرف (معرّفات مستخدم Matrix الكاملة).
- يمكن لقوائم السماح الخاصة بكل غرفة `users` تقييد المرسلين داخل غرفة محددة بشكل إضافي (استخدم معرّفات مستخدم Matrix الكاملة).
- يطلب معالج الإعداد قوائم السماح للغرف (معرّفات الغرف أو الأسماء المستعارة أو الأسماء) ولا يحلّ الأسماء إلا عند تطابق فريد ودقيق.
- عند بدء التشغيل، يحلّ OpenClaw أسماء الغرف/المستخدمين في قوائم السماح إلى معرّفات ويسجّل المطابقة؛ ويتم تجاهل الإدخالات غير المحلولة عند مطابقة قائمة السماح.
- تتم الانضمامات التلقائية للدعوات افتراضيًا؛ تحكّم بها عبر `channels.matrix.autoJoin` و `channels.matrix.autoJoinAllowlist`.
- للسماح **بعدم وجود غرف**، اضبط `channels.matrix.groupPolicy: "disabled"` (أو اترك قائمة السماح فارغة).
- المفتاح القديم: `channels.matrix.rooms` (بالشكل نفسه لـ `groups`).

## السلاسل (Threads)

- دعم سلاسل الردود متوفر.
- يتحكم `channels.matrix.threadReplies` فيما إذا كانت الردود تبقى ضمن السلاسل:
  - `off`، `inbound` (الافتراضي)، `always`
- يتحكم `channels.matrix.replyToMode` ببيانات الردّ عند عدم الرد ضمن سلسلة:
  - `off` (الافتراضي)، `first`، `all`

## الإمكانات

| الميزة           | الحالة                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| الرسائل المباشرة | ✅ مدعومة                                                                                            |
| الغرف            | ✅ مدعومة                                                                                            |
| Threads          | ✅ مدعومة                                                                                            |
| الوسائط          | ✅ مدعومة                                                                                            |
| E2EE             | ✅ مدعوم (يتطلب وحدة تشفير)                                                       |
| التفاعلات        | ✅ مدعومة (إرسال/قراءة عبر الأدوات)                                               |
| الاستطلاعات      | ✅ الإرسال مدعوم؛ تُحوَّل بدايات الاستطلاع الواردة إلى نص (تجاهل الردود/النهايات) |
| الموقع           | ✅ مدعوم (URI جغرافي؛ يتم تجاهل الارتفاع)                                         |
| الأوامر الأصلية  | ✅ مدعومة                                                                                            |

## استكشاف الأخطاء وإصلاحها

شغّل هذا التسلسل أولًا:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ثم قم بتأكيد حالة إقران DM إذا لزم الأمر:

```bash
openclaw pairing list matrix
```

إخفاقات شائعة:

- تم تسجيل الدخول لكن تُتجاهل رسائل الغرف: الغرفة محجوبة بواسطة `groupPolicy` أو قائمة السماح للغرف.
- تُتجاهل الرسائل المباشرة: المرسل بانتظار الموافقة عندما يكون `channels.matrix.dm.policy="pairing"`.
- فشل الغرف المشفّرة: عدم توافق دعم التشفير أو إعدادات التشفير.

لتدفّق الفرز: [/channels/troubleshooting](/channels/troubleshooting).

## مرجع التهيئة (Matrix)

التهيئة الكاملة: [Configuration](/gateway/configuration)

خيارات الموفّر:

- `channels.matrix.enabled`: تمكين/تعطيل بدء القناة.
- `channels.matrix.homeserver`: عنوان خادم Matrix المنزلي.
- `channels.matrix.userId`: معرّف مستخدم Matrix (اختياري مع رمز الوصول).
- `channels.matrix.accessToken`: رمز الوصول.
- `channels.matrix.password`: كلمة مرور لتسجيل الدخول (يتم تخزين الرمز).
- `channels.matrix.deviceName`: اسم عرض الجهاز.
- `channels.matrix.encryption`: تمكين E2EE (الافتراضي: false).
- `channels.matrix.initialSyncLimit`: حدّ المزامنة الأولية.
- `channels.matrix.threadReplies`: `off | inbound | always` (الافتراضي: inbound).
- `channels.matrix.textChunkLimit`: حجم تجزئة النص الصادر (عدد الأحرف).
- `channels.matrix.chunkMode`: `length` (الافتراضي) أو `newline` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التقسيم حسب الطول.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (الافتراضي: pairing).
- `channels.matrix.dm.allowFrom`: قائمة السماح للرسائل المباشرة (معرّفات مستخدم Matrix الكاملة). يتطلب `open` وجود `"*"`. يحلّ المعالج الأسماء إلى معرّفات عند الإمكان.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (الافتراضي: allowlist).
- `channels.matrix.groupAllowFrom`: المرسلون المسموح لهم لرسائل المجموعات (معرّفات مستخدم Matrix الكاملة).
- `channels.matrix.allowlistOnly`: فرض قواعد قائمة السماح على الرسائل المباشرة + الغرف.
- `channels.matrix.groups`: قائمة سماح المجموعات + خريطة إعدادات لكل غرفة.
- `channels.matrix.rooms`: تهيئة/قائمة سماح قديمة للمجموعات.
- `channels.matrix.replyToMode`: وضع الردّ للسلاسل/الوسوم.
- `channels.matrix.mediaMaxMb`: حدّ الوسائط الواردة/الصادرة (ميغابايت).
- `channels.matrix.autoJoin`: التعامل مع الدعوات (`always | allowlist | off`، الافتراضي: always).
- `channels.matrix.autoJoinAllowlist`: معرّفات/أسماء الغرف المسموح بها للانضمام التلقائي.
- `channels.matrix.actions`: تقييد الأدوات لكل إجراء (reactions/messages/pins/memberInfo/channelInfo).
