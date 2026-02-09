---
summary: "دليل تشخيص متعمّق لـ Gateway والقنوات والأتمتة والعُقد والمتصفح"
read_when:
  - أحالك مركز استكشاف الأخطاء وإصلاحها إلى هنا لإجراء تشخيص أعمق
  - تحتاج إلى أقسام دليل قائمة على الأعراض وبأوامر دقيقة
title: "استكشاف الأخطاء وإصلاحها"
---

# استكشاف أخطاء Gateway وإصلاحها

هذه الصفحة هي دليل التشغيل المتعمّق.
ابدأ من [/help/troubleshooting](/help/troubleshooting) إذا كنت تريد مسار الفرز السريع أولًا.

## سلّم الأوامر

شغّل هذه أولًا، وبهذا الترتيب:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

الإشارات السليمة المتوقعة:

- `openclaw gateway status` يعرض `Runtime: running` و `RPC probe: ok`.
- `openclaw doctor` يبلّغ عن عدم وجود مشكلات تهيئة/خدمة حاجبة.
- `openclaw channels status --probe` يعرض قنوات متصلة/جاهزة.

## لا توجد ردود

إذا كانت القنوات تعمل ولكن لا يصل أي رد، فتحقّق من التوجيه والسياسات قبل إعادة توصيل أي شيء.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

ابحث عن:

- الإقران معلق للمرسلين DM.
- بوابة الإشارة في المجموعات (`requireMention`، `mentionPatterns`).
- عدم تطابق قوائم السماح للقناة/المجموعة.

التوقيعات المشتركة:

- `drop guild message (mention required` → تجاهل رسالة المجموعة حتى تتم الإشارة.
- `pairing request` → يحتاج المرسل إلى موافقة.
- `blocked` / `allowlist` → تمّت تصفية المرسل/القناة بواسطة السياسة.

ذات صلة:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## اتصال واجهة التحكم في لوحة المعلومات

عندما لا تتصل لوحة المعلومات/واجهة التحكم، تحقّق من عنوان URL، ووضع المصادقة، وافتراضات السياق الآمن.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

ابحث عن:

- عنوان URL الصحيح للفحص وعنوان URL الصحيح للوحة المعلومات.
- عدم تطابق وضع/رمز المصادقة بين العميل و Gateway.
- استخدام HTTP حيث تكون هوية الجهاز مطلوبة.

التوقيعات المشتركة:

- `device identity required` → سياق غير آمن أو مصادقة جهاز مفقودة.
- `unauthorized` / حلقة إعادة الاتصال → عدم تطابق الرمز/كلمة المرور.
- `gateway connect failed:` → هدف مضيف/منفذ/عنوان URL خاطئ.

ذات صلة:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## خدمة Gateway لا تعمل

استخدم هذا عندما تكون الخدمة مثبّتة لكن العملية لا تبقى قيد التشغيل.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

ابحث عن:

- `Runtime: stopped` مع تلميحات الخروج.
- عدم تطابق تهيئة الخدمة (`Config (cli)` مقابل `Config (service)`).
- تعارضات المنافذ/المستمعين.

التوقيعات المشتركة:

- `Gateway start blocked: set gateway.mode=local` → لم يتم تمكين وضع Gateway المحلي.
- `refusing to bind gateway ... without auth` → ربط غير loopback بدون رمز/كلمة مرور.
- `another gateway instance is already listening` / `EADDRINUSE` → تعارض منفذ.

ذات صلة:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## القناة متصلة لكن الرسائل لا تتدفّق

إذا كانت حالة القناة «متصلة» لكن تدفّق الرسائل متوقف، فركّز على السياسات والأذونات وقواعد التسليم الخاصة بالقناة.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

ابحث عن:

- سياسة الرسائل المباشرة (`pairing`، `allowlist`، `open`، `disabled`).
- قائمة السماح للمجموعات ومتطلبات الإشارة.
- أذونات/نطاقات واجهة برمجة التطبيقات الخاصة بالقناة المفقودة.

التوقيعات المشتركة:

- `mention required` → تم تجاهل الرسالة بسبب سياسة الإشارة في المجموعة.
- `pairing` / آثار موافقة معلّقة → المرسل غير معتمد.
- `missing_scope`، `not_in_channel`، `Forbidden`، `401/403` → مشكلة مصادقة/أذونات القناة.

ذات صلة:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## تسليم Cron وHeartbeat

إذا لم يعمل cron أو heartbeat أو لم يتم التسليم، فتحقّق أولًا من حالة المُجَدول ثم من هدف التسليم.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

ابحث عن:

- تمكين Cron ووجود وقت الاستيقاظ التالي.
- حالة سجل تشغيل المهام (`ok`، `skipped`، `error`).
- أسباب تخطّي Heartbeat (`quiet-hours`، `requests-in-flight`، `alerts-disabled`).

التوقيعات المشتركة:

- `cron: scheduler disabled; jobs will not run automatically` → Cron معطّل.
- `cron: timer tick failed` → فشل نبضة المُجَدول؛ تحقّق من أخطاء الملفات/السجلات/وقت التشغيل.
- `heartbeat skipped` مع `reason=quiet-hours` → خارج نافذة الساعات النشطة.
- `heartbeat: unknown accountId` → معرّف حساب غير صالح لهدف تسليم Heartbeat.

ذات صلة:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## فشل أداة عُقدة مقترنة

إذا كانت العُقدة مقترنة لكن الأدوات تفشل، فاعزل حالة المقدّمة، والأذونات، والموافقة.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

ابحث عن:

- عقد على الإنترنت مع القدرات المتوقعة.
- منح أذونات نظام التشغيل للكاميرا/الميكروفون/الموقع/الشاشة.
- موافقات التنفيذ وحالة قائمة السماح.

التوقيعات المشتركة:

- `NODE_BACKGROUND_UNAVAILABLE` → يجب أن يكون تطبيق العُقدة في الواجهة الأمامية.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → إذن نظام تشغيل مفقود.
- `SYSTEM_RUN_DENIED: approval required` → موافقة التنفيذ معلّقة.
- `SYSTEM_RUN_DENIED: allowlist miss` → تم حظر الأمر بواسطة قائمة السماح.

ذات صلة:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## فشل أداة المتصفح

استخدم هذا عندما تفشل إجراءات أداة المتصفح رغم أن Gateway نفسه سليم.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

ابحث عن:

- مسار صالح لتنفيذ المتصفح.
- إمكانية الوصول إلى ملف تعريف CDP.
- إرفاق علامة تبويب ترحيل الامتداد لـ `profile="chrome"`.

التوقيعات المشتركة:

- `Failed to start Chrome CDP on port` → فشل تشغيل عملية المتصفح.
- `browser.executablePath not found` → المسار المُهيّأ غير صالح.
- `Chrome extension relay is running, but no tab is connected` → لم يتم إرفاق ترحيل الامتداد.
- `Browser attachOnly is enabled ... not reachable` → ملف تعريف «attach-only» لا يحتوي على هدف قابل للوصول.

ذات صلة:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## إذا قمت بالترقية وتعطّل شيء فجأة

معظم الأعطال بعد الترقية ناتجة عن انجراف التهيئة أو فرض افتراضات افتراضية أكثر صرامة الآن.

### 1. تغيّر سلوك تجاوز المصادقة وعنوان URL

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

ما الذي يجب التحقّق منه:

- إذا كان `gateway.mode=remote`، فقد تستهدف استدعاءات CLI خدمة بعيدة بينما خدمتك المحلية سليمة.
- الاستدعاءات الصريحة `--url` لا تعود إلى بيانات الاعتماد المخزّنة.

التوقيعات المشتركة:

- `gateway connect failed:` → هدف URL خاطئ.
- `unauthorized` → نقطة النهاية قابلة للوصول لكن المصادقة خاطئة.

### 2. أصبحت ضوابط الربط والمصادقة أكثر صرامة

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

ما الذي يجب التحقّق منه:

- الروابط غير loopback (`lan`، `tailnet`، `custom`) تتطلب تهيئة المصادقة.
- المفاتيح القديمة مثل `gateway.token` لا تستبدل `gateway.auth.token`.

التوقيعات المشتركة:

- `refusing to bind gateway ... without auth` → عدم تطابق الربط+المصادقة.
- `RPC probe: failed` بينما وقت التشغيل يعمل → Gateway حيّ لكنه غير قابل للوصول بالمصادقة/عنوان URL الحاليين.

### 3. تغيّرت حالة الاقتران وهوية الجهاز

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

ما الذي يجب التحقّق منه:

- موافقات الأجهزة المعلّقة للوحة المعلومات/العُقد.
- موافقات اقتران الرسائل المباشرة المعلّقة بعد تغييرات السياسة أو الهوية.

التوقيعات المشتركة:

- `device identity required` → لم يتم استيفاء مصادقة الجهاز.
- `pairing required` → يجب اعتماد المرسل/الجهاز.

إذا استمر عدم التوافق بين تهيئة الخدمة ووقت التشغيل بعد الفحوصات، فأعد تثبيت بيانات الخدمة الوصفية من نفس دليل الملف الشخصي/الحالة:

```bash
openclaw gateway install --force
openclaw gateway restart
```

ذات صلة:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
