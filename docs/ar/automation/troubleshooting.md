---
summary: "استكشاف أخطاء جدولة cron ونبضات Heartbeat وتسليمها وإصلاحها"
read_when:
  - لم يعمل Cron
  - تم تشغيل Cron ولكن لم يتم تسليم أي رسالة
  - يبدو أن Heartbeat صامت أو تم تخطيه
title: "استكشاف أخطاء الأتمتة وإصلاحها"
---

# automation/troubleshooting.md

استخدم هذه الصفحة لمشكلات المجدول والتسليم (`cron` + `heartbeat`).

## سلّم الأوامر

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ثم شغّل فحوصات الأتمتة:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron لا يعمل

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

يبدو الخرج الجيد كما يلي:

- `cron status` يبلّغ بأنه مُمكّن وبوجود `nextWakeAtMs` مستقبلي.
- المهمة مُمكّنة ولديها جدول/منطقة زمنية صالحة.
- `cron runs` يُظهر `ok` أو سبب تخطٍّ صريح.

التوقيعات المشتركة:

- `cron: scheduler disabled; jobs will not run automatically` → تم تعطيل cron في التهيئة/متغيرات البيئة.
- `cron: timer tick failed` → تعطل نبض المجدول؛ افحص سياق المكدس/السجلات المحيطة.
- `reason: not-due` في خرج التشغيل → تم استدعاء تشغيل يدوي بدون `--force` ولم يحن موعد المهمة بعد.

## تم تشغيل Cron ولكن لم يحدث تسليم

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

يبدو الخرج الجيد كما يلي:

- حالة التشغيل هي `ok`.
- تم تعيين وضع/هدف التسليم للمهام المعزولة.
- فحص القناة يبلّغ بأن القناة الهدف متصلة.

التوقيعات المشتركة:

- نجح التشغيل لكن وضع التسليم هو `none` → لا يُتوقع إرسال رسالة خارجية.
- هدف التسليم مفقود/غير صالح (`channel`/`to`) → قد ينجح التشغيل داخليًا لكنه يتجاوز الإرسال الخارجي.
- أخطاء مصادقة القناة (`unauthorized`، `missing_scope`، `Forbidden`) → تم حظر التسليم بسبب بيانات اعتماد/أذونات القناة.

## تم كبت Heartbeat أو تخطيه

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

يبدو الخرج الجيد كما يلي:

- Heartbeat مُمكّن بفاصل غير صفري.
- آخر نتيجة Heartbeat هي `ran` (أو أن سبب التخطي مفهوم).

التوقيعات المشتركة:

- `heartbeat skipped` مع `reason=quiet-hours` → خارج `activeHours`.
- `requests-in-flight` → المسار الرئيسي مشغول؛ تم تأجيل Heartbeat.
- `empty-heartbeat-file` → يوجد `HEARTBEAT.md` لكنه لا يحتوي على محتوى قابل للتنفيذ.
- `alerts-disabled` → إعدادات الرؤية تكبت رسائل Heartbeat الصادرة.

## ملاحظات مهمة حول المنطقة الزمنية و activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

قواعد سريعة:

- `Config path not found: agents.defaults.userTimezone` يعني أن المفتاح غير مُعيّن؛ يعود Heartbeat إلى المنطقة الزمنية للمضيف (أو `activeHours.timezone` إذا كانت مُعيّنة).
- Cron بدون `--tz` يستخدم المنطقة الزمنية لمضيف Gateway.
- Heartbeat `activeHours` يستخدم دقة المنطقة الزمنية المُهيّأة (`user`، `local`، أو منطقة IANA صريحة).
- الطوابع الزمنية ISO بدون منطقة زمنية تُعامل على أنها UTC لجدولات cron `at`.

التوقيعات المشتركة:

- تعمل المهام في وقت ساعة حائط غير صحيح بعد تغييرات المنطقة الزمنية للمضيف.
- يتم تخطي Heartbeat دائمًا خلال ساعات النهار لديك لأن `activeHours.timezone` غير صحيح.

ذات صلة:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
