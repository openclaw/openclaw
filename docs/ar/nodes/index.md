---
summary: "العُقد: الاقتران، الإمكانات، الأذونات، ومساعدات CLI للوحة/الكاميرا/الشاشة/النظام"
read_when:
  - اقتران عُقد iOS/Android مع Gateway
  - استخدام لوحة/كاميرا العُقد لسياق الوكيل
  - إضافة أوامر عُقد جديدة أو مساعدات CLI
title: "Nodes"
---

# Nodes

**العُقدة** هي جهاز مُرافِق (macOS/iOS/Android/بدون واجهة) يتصل بـ **WebSocket** الخاص بـ Gateway (نفس المنفذ الخاص بالمشغّلين) مع `role: "node"` ويكشف سطح أوامر (مثل `canvas.*`، `camera.*`، `system.*`) عبر `node.invoke`. تفاصيل البروتوكول: [بروتوكول Gateway](/gateway/protocol).

نقل قديم: [بروتوكول Bridge](/gateway/bridge-protocol) ‏(TCP JSONL؛ مُهمل/مزال للعُقد الحالية).

يمكن لـ macOS أيضًا العمل في **وضع العُقدة**: يتصل تطبيق شريط القوائم بخادم WS الخاص بـ Gateway ويكشف أوامر اللوحة/الكاميرا المحلية الخاصة به كعُقدة (بحيث يعمل `openclaw nodes …` على هذا الـ Mac).

ملاحظات:

- العُقد **ملحقات** وليست بوابات. لا تُشغِّل خدمة البوابة.
- رسائل Telegram/WhatsApp/etc. تصل إلى **البوابة** وليس إلى العُقد.
- دليل استكشاف الأخطاء وإصلاحها: [/nodes/troubleshooting](/nodes/troubleshooting)

## الاقتران + الحالة

**عُقد WS تستخدم اقتران الأجهزة.** تعرض العُقد هوية جهاز أثناء `connect`؛ وتنشئ Gateway طلب اقتران جهاز لـ `role: node`. وافق عبر CLI الخاص بالأجهزة (أو الواجهة).

CLI سريع:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

ملاحظات:

- يُعلِّم `nodes status` العُقدة كـ **مقترنة** عندما يتضمن دور اقتران الجهاز `node`.
- `node.pair.*` ‏(CLI: `openclaw nodes pending/approve/reject`) هو مخزن اقتران عُقد منفصل مملوك للبوابة؛ ولا يقيّد مصافحة WS الخاصة بـ `connect`.

## مضيف عُقدة بعيد (system.run)

استخدم **مضيف عُقدة** عندما تعمل Gateway على جهاز وتريد تنفيذ الأوامر على جهاز آخر. لا يزال النموذج يتحدث إلى **البوابة**؛ وتُمرِّر البوابة استدعاءات `exec` إلى **مضيف العُقدة** عند اختيار `host=node`.

### ما الذي يعمل وأين

- **مضيف Gateway**: يستقبل الرسائل، يُشغِّل النموذج، ويوجّه استدعاءات الأدوات.
- **مضيف العُقدة**: ينفّذ `system.run`/`system.which` على جهاز العُقدة.
- **الموافقات**: تُفرَض على مضيف العُقدة عبر `~/.openclaw/exec-approvals.json`.

### بدء مضيف عُقدة (في الواجهة الأمامية)

على جهاز العُقدة:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### بوابة بعيدة عبر نفق SSH (ربط loopback)

إذا كانت Gateway ترتبط بـ loopback ‏(`gateway.bind=loopback`، الافتراضي في الوضع المحلي)، فلا يمكن لمضيفي العُقدة البعيدين الاتصال مباشرة. أنشئ نفق SSH ووجّه مضيف العُقدة إلى الطرف المحلي للنفق.

مثال (مضيف العُقدة -> مضيف البوابة):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

ملاحظات:

- الرمز المميّز هو `gateway.auth.token` من تهيئة البوابة (`~/.openclaw/openclaw.json` على مضيف البوابة).
- يقرأ `openclaw node run` قيمة `OPENCLAW_GATEWAY_TOKEN` للمصادقة.

### بدء مضيف عُقدة (كخدمة)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### الاقتران + التسمية

على مضيف البوابة:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

خيارات التسمية:

- `--display-name` على `openclaw node run` / `openclaw node install` (يستمر في `~/.openclaw/node.json` على العُقدة).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (تجاوز من البوابة).

### إدراج الأوامر في قائمة السماح

موافقات التنفيذ تكون **لكل مضيف عُقدة**. أضف إدخالات قائمة السماح من البوابة:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

توجد الموافقات على مضيف العُقدة في `~/.openclaw/exec-approvals.json`.

### نقطة خارجية في العقدة

اضبط القيم الافتراضية (تهيئة البوابة):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

أو لكل جلسة:

```
/exec host=node security=allowlist node=<id-or-name>
```

بعد الضبط، فإن أي استدعاء `exec` مع `host=node` يُنفَّذ على مضيف العُقدة (وفقًا لقائمة السماح/الموافقات الخاصة بالعُقدة).

ذو صلة:

- [CLI مضيف العُقدة](/cli/node)
- [أداة Exec](/tools/exec)
- [موافقات Exec](/tools/exec-approvals)

## استدعاء الأوامر

منخفض المستوى (RPC خام):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

تتوفر مساعدات أعلى مستوى لسير العمل الشائع «إعطاء الوكيل مرفق MEDIA».

## لقطات الشاشة (لقطات اللوحة)

إذا كانت العُقدة تعرض اللوحة (WebView)، فإن `canvas.snapshot` يعيد `{ format, base64 }`.

مساعد CLI (يكتب إلى ملف مؤقت ويطبع `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### عناصر تحكم اللوحة

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

ملاحظات:

- يقبل `canvas present` عناوين URL أو مسارات ملفات محلية (`--target`)، بالإضافة إلى `--x/--y/--width/--height` اختياريًا للتموضع.
- يقبل `canvas eval` شيفرة JavaScript مضمنة (`--js`) أو وسيطًا موضعيًا.

### A2UI (اللوحة)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

ملاحظات:

- مدعوم فقط A2UI v0.8 JSONL (يتم رفض v0.9/createSurface).

## الصور + الفيديوهات (كاميرا العُقدة)

الصور (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

مقاطع الفيديو (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

ملاحظات:

- يجب أن تكون العُقدة **في المقدّمة** لـ `canvas.*` و `camera.*` (تُرجع الاستدعاءات في الخلفية `NODE_BACKGROUND_UNAVAILABLE`).
- يتم تقييد مدة المقطع (حاليًا `<= 60s`) لتجنّب حمولات base64 كبيرة الحجم.
- سيطلب Android أذونات `CAMERA`/`RECORD_AUDIO` عند الإمكان؛ الأذونات المرفوضة تفشل بـ `*_PERMISSION_REQUIRED`.

## تسجيلات الشاشة (العُقد)

تكشف العُقد `screen.record` ‏(mp4). مثال:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

ملاحظات:

- يتطلب `screen.record` أن يكون تطبيق العُقدة في المقدّمة.
- سيعرض Android مطالبة النظام لالتقاط الشاشة قبل التسجيل.
- يتم تقييد تسجيلات الشاشة إلى `<= 60s`.
- يعطّل `--no-audio` التقاط الميكروفون (مدعوم على iOS/Android؛ يستخدم macOS صوت التقاط النظام).
- استخدم `--screen <index>` لاختيار شاشة عند توفر شاشات متعددة.

## الموقع (العُقد)

تكشف العُقد `location.get` عندما يكون الموقع مُمكّنًا في الإعدادات.

مساعد CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

ملاحظات:

- الموقع **معطّل افتراضيًا**.
- يتطلب خيار «دائمًا» إذن النظام؛ والجلب في الخلفية يكون بأفضل جهد.
- تتضمن الاستجابة خط العرض/خط الطول، والدقة (بالأمتار)، والطابع الزمني.

## SMS (عُقد Android)

يمكن لعُقد Android كشف `sms.send` عندما يمنح المستخدم إذن **SMS** ويدعم الجهاز الاتصال الهاتفي.

استدعاء منخفض المستوى:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

ملاحظات:

- يجب قبول مطالبة الإذن على جهاز Android قبل الإعلان عن القدرة.
- الأجهزة المعتمدة على Wi‑Fi فقط وبدون اتصال هاتفي لن تعلن عن `sms.send`.

## أوامر النظام (مضيف العُقدة / عُقدة mac)

تكشف عُقدة macOS `system.run`، `system.notify`، و `system.execApprovals.get/set`.
ويكشف مضيف العُقدة بدون واجهة `system.run`، `system.which`، و `system.execApprovals.get/set`.

أمثلة:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

ملاحظات:

- يعيد `system.run` stdout/stderr/رمز الخروج في الحمولة.
- يحترم `system.notify` حالة أذونات الإشعارات في تطبيق macOS.
- يدعم `system.run` كلاً من `--cwd`، `--env KEY=VAL`، `--command-timeout`، و `--needs-screen-recording`.
- يدعم `system.notify` كلاً من `--priority <passive|active|timeSensitive>` و `--delivery <system|overlay|auto>`.
- تسقط عُقد macOS تجاوزات `PATH`؛ ولا تقبل مضيفات العُقدة بدون واجهة إلا `PATH` عندما يسبق PATH الخاص بمضيف العُقدة.
- في وضع عُقدة macOS، يتم تقييد `system.run` بموافقات التنفيذ في تطبيق macOS (الإعدادات → Exec approvals).
  تعمل ask/allowlist/full بنفس سلوك مضيف العُقدة بدون واجهة؛ وتُرجِع المطالبات المرفوضة `SYSTEM_RUN_DENIED`.
- على مضيف العُقدة بدون واجهة، يتم تقييد `system.run` بموافقات التنفيذ (`~/.openclaw/exec-approvals.json`).

## ربط Exec بعُقدة

عند توفر عدة عُقد، يمكنك ربط Exec بعُقدة محددة.
يُعيّن هذا العُقدة الافتراضية لـ `exec host=node` (ويمكن تجاوزه لكل وكيل).

الافتراضي العام:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

تجاوز لكل وكيل:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

إلغاء الضبط للسماح بأي عُقدة:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## خريطة الأذونات

قد تتضمن العُقد خريطة `permissions` في `node.list` / `node.describe`، مفهرسة باسم الإذن (مثل `screenRecording`، `accessibility`) بقيم منطقية (`true` = مُنِح).

## مضيف عُقدة بدون واجهة (متعدد المنصات)

يمكن لـ OpenClaw تشغيل **مضيف عُقدة بدون واجهة** (بدون UI) يتصل بـ WebSocket الخاص بـ Gateway ويكشف `system.run` / `system.which`. هذا مفيد على Linux/Windows
أو لتشغيل عُقدة بسيطة بجوار خادم.

ابدأه:

```bash
openclaw node run --host <gateway-host> --port 18789
```

ملاحظات:

- لا يزال الاقتران مطلوبًا (ستعرض Gateway مطالبة موافقة على العُقدة).
- يخزن مضيف العُقدة معرّف العُقدة والرمز المميّز واسم العرض ومعلومات اتصال البوابة في `~/.openclaw/node.json`.
- تُفرَض موافقات التنفيذ محليًا عبر `~/.openclaw/exec-approvals.json`
  (انظر [موافقات Exec](/tools/exec-approvals)).
- على macOS، يفضّل مضيف العُقدة بدون واجهة مضيف التنفيذ الخاص بالتطبيق المُرافِق عند توفره، ويعود
  إلى التنفيذ المحلي إذا كان التطبيق غير متاح. اضبط `OPENCLAW_NODE_EXEC_HOST=app` لفرض
  استخدام التطبيق، أو `OPENCLAW_NODE_EXEC_FALLBACK=0` لتعطيل الرجوع.
- أضف `--tls` / `--tls-fingerprint` عندما يستخدم WS الخاص بـ Gateway بروتوكول TLS.

## وضع عُقدة Mac

- يتصل تطبيق شريط القوائم في macOS بخادم WS الخاص بـ Gateway كعُقدة (بحيث يعمل `openclaw nodes …` على هذا الـ Mac).
- في الوضع البعيد، يفتح التطبيق نفق SSH لمنفذ Gateway ويتصل بـ `localhost`.
