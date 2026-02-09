---
summary: "استكشاف أخطاء إقران العُقدة ومتطلبات المقدّمة والأذونات وتعطّل الأدوات وإصلاحها"
read_when:
  - تكون العُقدة متصلة لكن أدوات الكاميرا/اللوحة/الشاشة/التنفيذ تفشل
  - تحتاج إلى إقران العقدة مقابل الموافقة على النموذج العقلي
title: "استكشاف أخطاء العُقدة وإصلاحها"
---

# nodes/troubleshooting.md

استخدم هذه الصفحة عندما تكون العُقدة مرئية في الحالة لكن أدوات العُقدة تفشل.

## سلّم الأوامر

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ثم شغّل فحوصات خاصة بالعُقدة:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

إشارات السلامة:

- العُقدة متصلة ومقترنة للدور `node`.
- `nodes describe` يتضمن الإمكانية التي تستدعيها.
- تُظهر موافقات التنفيذ الوضع/قائمة السماح المتوقعة.

## متطلبات المقدّمة

`canvas.*` و`camera.*` و`screen.*` تعمل في المقدّمة فقط على عُقد iOS/Android.

فحص سريع وإصلاح:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

إذا رأيت `NODE_BACKGROUND_UNAVAILABLE`، فاجعل تطبيق العُقدة في المقدّمة ثم أعد المحاولة.

## مصفوفة الأذونات

| الإمكانية                    | iOS                                                            | Android                                                        | تطبيق العُقدة على macOS                                | رمز الفشل النموذجي             |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `camera.snap`، `camera.clip` | الكاميرا (+ الميكروفون لصوت المقطع)         | الكاميرا (+ الميكروفون لصوت المقطع)         | الكاميرا (+ الميكروفون لصوت المقطع) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | تسجيل الشاشة (+ الميكروفون اختياري)         | مطالبة التقاط الشاشة (+ الميكروفون اختياري) | تسجيل الشاشة                                           | `*_PERMISSION_REQUIRED`        |
| `location.get`               | أثناء الاستخدام أو دائمًا (يعتمد على الوضع) | الموقع في المقدّمة/الخلفية بحسب الوضع                          | إذن الموقع                                             | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (مسار مضيف العقدة)                      | n/a (مسار مضيف العقدة)                      | تتطلب موافقات التنفيذ                                  | `SYSTEM_RUN_DENIED`            |

## الإقران مقابل الموافقات

هذه بوابتان مختلفتان:

1. **إقران الجهاز**: هل يمكن لهذه العُقدة الاتصال بـ Gateway (البوابة)؟
2. **موافقات التنفيذ**: هل يمكن لهذه العُقدة تشغيل أمر صدفة محدد؟

فحوصات سريعة:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

إذا كان الإقران مفقودًا، فوافق على جهاز العُقدة أولًا.
إذا كان الإقران سليمًا لكن `system.run` يفشل، فأصلح موافقات التنفيذ/قائمة السماح.

## رموز أخطاء العُقدة الشائعة

- `NODE_BACKGROUND_UNAVAILABLE` → التطبيق في الخلفية؛ اجعله في المقدّمة.
- `CAMERA_DISABLED` → تعطيل مفتاح الكاميرا في إعدادات العُقدة.
- `*_PERMISSION_REQUIRED` → إذن نظام التشغيل مفقود/مرفوض.
- `LOCATION_DISABLED` → وضع الموقع متوقف.
- `LOCATION_PERMISSION_REQUIRED` → لم يتم منح وضع الموقع المطلوب.
- `LOCATION_BACKGROUND_UNAVAILABLE` → التطبيق في الخلفية لكن يوجد إذن «أثناء الاستخدام» فقط.
- `SYSTEM_RUN_DENIED: approval required` → طلب التنفيذ يحتاج موافقة صريحة.
- `SYSTEM_RUN_DENIED: allowlist miss` → الأمر محظور بواسطة وضع قائمة السماح.

## حلقة استعادة سريعة

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

إذا استمر التعطّل:

- إعادة الموافقة على إقران الجهاز.
- إعادة فتح تطبيق العُقدة (في المقدّمة).
- إعادة منح أذونات نظام التشغيل.
- إعادة إنشاء/تعديل سياسة موافقات التنفيذ.

ذو صلة:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
