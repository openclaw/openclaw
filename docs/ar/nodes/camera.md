---
summary: "التقاط الكاميرا (عُقدة iOS + تطبيق macOS) لاستخدام الوكيل: صور (jpg) ومقاطع فيديو قصيرة (mp4)"
read_when:
  - عند إضافة أو تعديل التقاط الكاميرا على عُقد iOS أو macOS
  - عند توسيع سير عمل ملفات MEDIA المؤقتة المتاحة للوكيل
title: "التقاط الكاميرا"
---

# التقاط الكاميرا (الوكيل)

يدعم OpenClaw **التقاط الكاميرا** لسير عمل الوكيل:

- **عُقدة iOS** (مقترنة عبر Gateway): التقاط **صورة** (`jpg`) أو **مقطع فيديو قصير** (`mp4`، مع صوت اختياري) عبر `node.invoke`.
- **عُقدة Android** (مقترنة عبر Gateway): التقاط **صورة** (`jpg`) أو **مقطع فيديو قصير** (`mp4`، مع صوت اختياري) عبر `node.invoke`.
- **تطبيق macOS** (عُقدة عبر Gateway): التقاط **صورة** (`jpg`) أو **مقطع فيديو قصير** (`mp4`، مع صوت اختياري) عبر `node.invoke`.

يتم تقييد كل وصول إلى الكاميرا بإعدادات **يتحكم بها المستخدم**.

## عُقدة iOS

### إعداد المستخدم (مفعّل افتراضيًا)

- علامة تبويب إعدادات iOS → **Camera** → **Allow Camera** (`camera.enabled`)
  - الافتراضي: **مفعّل** (يُعدّ المفتاح المفقود مفعّلًا).
  - عند الإيقاف: تُرجع أوامر `camera.*` الخطأ `CAMERA_DISABLED`.

### الأوامر (عبر Gateway `node.invoke`)

- `camera.list`
  - حمولة الاستجابة:
    - `devices`: مصفوفة من `{ id, name, position, deviceType }`

- `camera.snap`
  - Params:
    - `facing`: `front|back` (الافتراضي: `front`)
    - `maxWidth`: رقم (اختياري؛ الافتراضي `1600` على عُقدة iOS)
    - `quality`: `0..1` (اختياري؛ الافتراضي `0.9`)
    - `format`: حاليًا `jpg`
    - `delayMs`: رقم (اختياري؛ الافتراضي `0`)
    - `deviceId`: سلسلة (اختياري؛ من `camera.list`)
  - حمولة الاستجابة:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`، `height`
  - حارس الحمولة: تُعاد ضغط الصور للحفاظ على حمولة base64 دون 5 ميغابايت.

- `camera.clip`
  - Params:
    - `facing`: `front|back` (الافتراضي: `front`)
    - `durationMs`: رقم (الافتراضي `3000`، ومقيد بحد أقصى `60000`)
    - `includeAudio`: قيمة منطقية (الافتراضي `true`)
    - `format`: حاليًا `mp4`
    - `deviceId`: سلسلة (اختياري؛ من `camera.list`)
  - حمولة الاستجابة:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### متطلب الواجهة الأمامية

مثل `canvas.*`، تسمح عُقدة iOS بأوامر `camera.*` فقط في **الواجهة الأمامية**. تُرجع الاستدعاءات في الخلفية `NODE_BACKGROUND_UNAVAILABLE`.

### مساعد CLI (ملفات مؤقتة + MEDIA)

أسهل طريقة للحصول على المرفقات هي عبر مساعد CLI، الذي يكتب الوسائط المفككة إلى ملف مؤقت ويطبع `MEDIA:<path>`.

أمثلة:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

ملاحظات:

- `nodes camera snap` يكون افتراضيًا **كلا** الاتجاهين لإتاحة العرضين للوكيل.
- ملفات الإخراج مؤقتة (في دليل الملفات المؤقتة لنظام التشغيل) ما لم تُنشئ غلافك الخاص.

## عُقدة Android

### إعداد المستخدم في Android (مفعّل افتراضيًا)

- ورقة إعدادات Android → **Camera** → **Allow Camera** (`camera.enabled`)
  - الافتراضي: **مفعّل** (يُعدّ المفتاح المفقود مفعّلًا).
  - عند الإيقاف: تُرجع أوامر `camera.*` الخطأ `CAMERA_DISABLED`.

### الأذونات

- يتطلب Android أذونات وقت التشغيل:
  - `CAMERA` لكل من `camera.snap` و`camera.clip`.
  - `RECORD_AUDIO` لـ `camera.clip` عندما `includeAudio=true`.

إذا كانت الأذونات مفقودة، فسيطالب التطبيق عند الإمكان؛ وإذا رُفضت، تفشل طلبات `camera.*` مع خطأ
`*_PERMISSION_REQUIRED`.

### متطلب الواجهة الأمامية في Android

مثل `canvas.*`، تسمح عُقدة Android بأوامر `camera.*` فقط في **الواجهة الأمامية**. تُرجع الاستدعاءات في الخلفية `NODE_BACKGROUND_UNAVAILABLE`.

### حارس الحمولة

تُعاد ضغط الصور للحفاظ على حمولة base64 دون 5 ميغابايت.

## تطبيق macOS

### إعداد المستخدم (مُعطّل افتراضيًا)

يعرض التطبيق المُرافِق لنظام macOS مربع اختيار:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - الافتراضي: **مُعطّل**
  - عند الإيقاف: تُرجع طلبات الكاميرا «Camera disabled by user».

### مساعد CLI (استدعاء العُقدة)

استخدم CLI الرئيسي `openclaw` لاستدعاء أوامر الكاميرا على عُقدة macOS.

أمثلة:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

ملاحظات:

- `openclaw nodes camera snap` يكون افتراضيًا `maxWidth=1600` ما لم يتم تجاوزه.
- على macOS، ينتظر `camera.snap` مدة `delayMs` (الافتراضي 2000 مللي ثانية) بعد الإحماء/استقرار التعريض قبل الالتقاط.
- تُعاد ضغط حمولات الصور للحفاظ على base64 دون 5 ميغابايت.

## السلامة + الحدود العملية

- يؤدي الوصول إلى الكاميرا والميكروفون إلى ظهور مطالبات أذونات نظام التشغيل المعتادة (ويتطلب سلاسل الاستخدام في Info.plist).
- يتم تحديد سقف لمقاطع الفيديو (حاليًا `<= 60s`) لتجنب حمولات عُقد كبيرة الحجم (عبء base64 + حدود الرسائل).

## فيديو شاشة macOS (على مستوى النظام)

لفيديو **الشاشة** (وليس الكاميرا)، استخدم التطبيق المُرافِق لنظام macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

ملاحظات:

- يتطلب إذن **Screen Recording** في macOS (TCC).
