---
summary: "دليل تشغيل لخدمة Gateway ودورة حياتها وعملياتها"
read_when:
  - عند تشغيل عملية Gateway أو تصحيح أخطائها
title: "دليل تشغيل Gateway"
---

# دليل تشغيل خدمة Gateway

آخر تحديث: 2025-12-09

## ما هي

- العملية الدائمة التشغيل التي تمتلك اتصال Baileys/Telegram الوحيد ومستوى التحكم/الأحداث.
- تحل محل الأمر القديم `gateway`. نقطة دخول CLI: `openclaw gateway`.
- تعمل حتى يتم إيقافها؛ وتخرج برمز غير صفري عند الأخطاء القاتلة كي يعيد المشرف تشغيلها.

## كيفية التشغيل (محليًا)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- إعادة تحميل التهيئة الساخنة تراقب `~/.openclaw/openclaw.json` (أو `OPENCLAW_CONFIG_PATH`).
  - الوضع الافتراضي: `gateway.reload.mode="hybrid"` (تطبيق فوري للتغييرات الآمنة، وإعادة تشغيل عند الحرجة).
  - إعادة التحميل الساخنة تستخدم إعادة تشغيل داخل العملية عبر **SIGUSR1** عند الحاجة.
  - التعطيل باستخدام `gateway.reload.mode="off"`.
- ربط مستوى التحكم عبر WebSocket إلى `127.0.0.1:<port>` (الافتراضي 18789).
- المنفذ نفسه يخدم أيضًا HTTP (واجهة تحكم، hooks، A2UI). تعدد الإرسال على منفذ واحد.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- يبدأ خادم ملفات Canvas افتراضيًا على `canvasHost.port` (الافتراضي `18793`)، ويخدم `http://<gateway-host>:18793/__openclaw__/canvas/` من `~/.openclaw/workspace/canvas`. عطّل باستخدام `canvasHost.enabled=false` أو `OPENCLAW_SKIP_CANVAS_HOST=1`.
- يسجل إلى stdout؛ استخدم launchd/systemd لإبقائه حيًا وتدوير السجلات.
- مرّر `--verbose` لنسخ سجلات التصحيح (المصافحات، الطلب/الاستجابة، الأحداث) من ملف السجل إلى stdio عند استكشاف الأخطاء وإصلاحها.
- `--force` يستخدم `lsof` للعثور على المستمعين على المنفذ المختار، يرسل SIGTERM، يسجل ما قام بإنهائه، ثم يبدأ Gateway (يفشل سريعًا إذا كان `lsof` مفقودًا).
- إذا كنت تشغّل تحت مشرف (launchd/systemd/وضع عملية فرعية لتطبيق mac)، فإن الإيقاف/إعادة التشغيل يرسل عادة **SIGTERM**؛ وقد تُظهر الإصدارات الأقدم ذلك كـ `pnpm` `ELIFECYCLE` برمز خروج **143** (SIGTERM)، وهو إيقاف طبيعي وليس انهيارًا.
- **SIGUSR1** يُشغّل إعادة تشغيل داخل العملية عند التفويض (أداة Gateway/تطبيق/تحديث التهيئة، أو فعّل `commands.restart` لإعادة تشغيل يدوية).
- يتطلب توثيق Gateway افتراضيًا: اضبط `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`) أو `gateway.auth.password`. يجب على العملاء إرسال `connect.params.auth.token/password` ما لم يستخدموا هوية Tailscale Serve.
- يقوم المعالج الآن بإنشاء رمز مميز افتراضيًا، حتى على loopback.
- أسبقية المنفذ: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > الافتراضي `18789`.

## الوصول عن بُعد

- يُفضَّل Tailscale/VPN؛ وإلا فنفق SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- يتصل العملاء بعد ذلك بـ `ws://127.0.0.1:18789` عبر النفق.

- إذا كان الرمز المميز مضبوطًا، يجب على العملاء تضمينه في `connect.params.auth.token` حتى عبر النفق.

## بوابات متعددة (على المضيف نفسه)

غالبًا غير ضروري: يمكن لـ Gateway واحدة خدمة قنوات مراسلة ووكلاء متعددين. استخدم بوابات متعددة فقط للتكرار أو العزل الصارم (مثل: روبوت إنقاذ).

مدعوم إذا قمت بعزل الحالة + التهيئة واستخدمت منافذ فريدة. الدليل الكامل: [بوابات متعددة](/gateway/multiple-gateways).

أسماء الخدمات واعية بالملف الشخصي:

- macOS: `bot.molt.<profile>` (قد يظل القديم `com.openclaw.*` موجودًا)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

بيانات التثبيت مُضمّنة في تهيئة الخدمة:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

نمط روبوت الإنقاذ: احتفِظ بـ Gateway ثانية معزولة بملفها الشخصي الخاص، ودليل الحالة، ومساحة العمل، وتباعد منافذ أساسي. الدليل الكامل: [دليل روبوت الإنقاذ](/gateway/multiple-gateways#rescue-bot-guide).

### ملف التطوير (`--dev`)

المسار السريع: شغّل نسخة تطوير معزولة بالكامل (تهيئة/حالة/مساحة عمل) دون المساس بإعدادك الأساسي.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

الافتراضيات (يمكن تجاوزها عبر env/flags/التهيئة):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- منفذ خدمة تحكم المتصفح = `19003` (مُشتق: `gateway.port+2`، loopback فقط)
- `canvasHost.port=19005` (مُشتق: `gateway.port+4`)
- يصبح الافتراضي لـ `agents.defaults.workspace` هو `~/.openclaw/workspace-dev` عند تشغيل `setup`/`onboard` تحت `--dev`.

المنافذ المُشتقة (قواعد إرشادية):

- المنفذ الأساسي = `gateway.port` (أو `OPENCLAW_GATEWAY_PORT` / `--port`)
- منفذ خدمة تحكم المتصفح = الأساسي + 2 (loopback فقط)
- `canvasHost.port = base + 4` (أو `OPENCLAW_CANVAS_HOST_PORT` / تجاوز التهيئة)
- تُخصَّص منافذ CDP لملف المتصفح تلقائيًا من `browser.controlPort + 9 .. + 108` (مُحفوظة لكل ملف شخصي).

Checklist per instance:

- `gateway.port` فريد
- `OPENCLAW_CONFIG_PATH` فريد
- `OPENCLAW_STATE_DIR` فريد
- `agents.defaults.workspace` فريد
- أرقام WhatsApp منفصلة (إن كنت تستخدم WA)

تثبيت الخدمة لكل ملف شخصي:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

مثال:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## البروتوكول (منظور المشغّل)

- الوثائق الكاملة: [بروتوكول Gateway](/gateway/protocol) و[بروتوكول Bridge (قديم)](/gateway/bridge-protocol).
- الإطار الأول الإلزامي من العميل: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- يرد Gateway بـ `res {type:"res", id, ok:true, payload:hello-ok }` (أو `ok:false` مع خطأ، ثم يغلق).
- بعد المصافحة:
  - الطلبات: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - الأحداث: `{type:"event", event, payload, seq?, stateVersion?}`
- إدخالات حضور مُنظَّمة: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (لعملاء WS، يأتي `instanceId` من `connect.client.instanceId`).
- استجابات `agent` على مرحلتين: أولًا تأكيد `res` `{runId,status:"accepted"}`، ثم `res` `{runId,status:"ok"|"error",summary}` النهائي بعد انتهاء التشغيل؛ ويصل الخرج المتدفق كـ `event:"agent"`.

## الأساليب (المجموعة الأولية)

- `health` — لقطة صحة كاملة (نفس البنية مثل `openclaw health --json`).
- `status` — ملخص قصير.
- `system-presence` — قائمة الحضور الحالية.
- `system-event` — نشر ملاحظة حضور/نظام (مُنظَّمة).
- `send` — إرسال رسالة عبر القناة/القنوات النشطة.
- `agent` — تنفيذ دور وكيل (يبث الأحداث عبر الاتصال نفسه).
- `node.list` — سرد العُقد المقترنة والمتصلة حاليًا (يتضمن `caps`، `deviceFamily`، `modelIdentifier`، `paired`، `connected`، و`commands` المُعلَن).
- `node.describe` — وصف عُقدة (القدرات + أوامر `node.invoke` المدعومة؛ يعمل للعُقد المقترنة وللعُقد غير المقترنة المتصلة حاليًا).
- `node.invoke` — استدعاء أمر على عُقدة (مثل `canvas.*`، `camera.*`).
- `node.pair.*` — دورة حياة الاقتران (`request`، `list`، `approve`، `reject`، `verify`).

انظر أيضًا: [الحضور](/concepts/presence) لمعرفة كيفية إنتاج الحضور وإزالة التكرار ولماذا يهم `client.instanceId` المستقر.

## الأحداث

- `agent` — أحداث أدوات/مخرجات مُتدفقة من تشغيل الوكيل (موسومة بتسلسل).
- `presence` — تحديثات الحضور (فروق مع stateVersion) تُدفَع إلى جميع العملاء المتصلين.
- `tick` — إبقاء الاتصال/لا-عملية دوري لتأكيد الحيوية.
- `shutdown` — Gateway بصدد الخروج؛ تتضمن الحمولة `reason` و`restartExpectedMs` الاختياري. يجب على العملاء إعادة الاتصال.

## تكامل WebChat

- WebChat واجهة SwiftUI أصلية تتحدث مباشرةً مع WebSocket الخاص بـ Gateway للتاريخ، والإرسال، والإلغاء، والأحداث.
- الاستخدام عن بُعد يمر عبر نفق SSH/Tailscale نفسه؛ وإذا كان رمز Gateway مضبوطًا، يضمنه العميل أثناء `connect`.
- يتصل تطبيق macOS عبر WS واحد (اتصال مشترك)؛ ويستكمل الحضور من اللقطة الأولية ويستمع لأحداث `presence` لتحديث الواجهة.

## الكتابة والتحقق

- يتحقق الخادم من كل إطار وارد باستخدام AJV مقابل JSON Schema المُصدَرة من تعريفات البروتوكول.
- يستهلك العملاء (TS/Swift) الأنواع المُولَّدة (TS مباشرة؛ Swift عبر مُولِّد المستودع).
- تعريفات البروتوكول هي مصدر الحقيقة؛ أعد توليد المخطط/النماذج باستخدام:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## لقطة الاتصال

- `hello-ok` تتضمن `snapshot` مع `presence`، `health`، `stateVersion`، و`uptimeMs` إضافةً إلى `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` كي يتمكن العملاء من العرض فورًا دون طلبات إضافية.
- تظل `health`/`system-presence` متاحة للتحديث اليدوي، لكنها غير مطلوبة وقت الاتصال.

## رموز الأخطاء (بنية res.error)

- تستخدم الأخطاء `{ code, message, details?, retryable?, retryAfterMs? }`.
- الرموز القياسية:
  - `NOT_LINKED` — WhatsApp غير مُوثَّق.
  - `AGENT_TIMEOUT` — لم يستجب الوكيل ضمن المهلة المضبوطة.
  - `INVALID_REQUEST` — فشل التحقق من المخطط/المعاملات.
  - `UNAVAILABLE` — Gateway قيد الإيقاف أو أن اعتمادًا غير متاح.

## سلوك الإبقاء حيًا

- تُصدَر أحداث `tick` (أو ping/pong لـ WS) دوريًا ليعرف العملاء أن Gateway حي حتى عند غياب الحركة.
- تبقى تأكيدات الإرسال/الوكيل استجابات منفصلة؛ لا تُحمِّل نبضات الإبقاء وظائف الإرسال.

## إعادة التشغيل / الفجوات

- لا تتم إعادة تشغيل الأحداث. يكتشف العملاء فجوات التسلسل ويجب عليهم التحديث (`health` + `system-presence`) قبل المتابعة. تقوم WebChat وعملاء macOS الآن بالتحديث التلقائي عند وجود فجوة.

## الإشراف (مثال macOS)

- استخدم launchd لإبقاء الخدمة حيّة:
  - Program: المسار إلى `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: مسارات ملفات أو `syslog`
- عند الفشل، يعيد launchd التشغيل؛ يجب أن يستمر سوء التهيئة القاتل في الخروج كي يلاحظه المشغّل.
- LaunchAgents لكل مستخدم وتتطلب جلسة مُسجّلة الدخول؛ للإعدادات دون واجهة استخدم LaunchDaemon مخصصًا (غير مُشحن).
  - `openclaw gateway install` يكتب `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (أو `bot.molt.<profile>.plist`؛ يتم تنظيف القديم `com.openclaw.*`).
  - `openclaw doctor` يدقق تهيئة LaunchAgent ويمكنه تحديثها إلى الافتراضيات الحالية.

## إدارة خدمة Gateway (CLI)

استخدم CLI الخاص بـ Gateway للتثبيت/البدء/الإيقاف/إعادة التشغيل/الحالة:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

ملاحظات:

- `gateway status` يفحص Gateway RPC افتراضيًا باستخدام المنفذ/التهيئة المحلولة للخدمة (تجاوز باستخدام `--url`).
- `gateway status --deep` يضيف عمليات مسح على مستوى النظام (LaunchDaemons/وحدات النظام).
- `gateway status --no-probe` يتجاوز فحص RPC (مفيد عند تعطل الشبكات).
- `gateway status --json` ثابت للاستخدام في السكربتات.
- `gateway status` يُبلِغ عن **تشغيل المشرف** (تشغيل launchd/systemd) منفصلًا عن **قابلية الوصول إلى RPC** (اتصال WS + استدعاء حالة RPC).
- `gateway status` يطبع مسار التهيئة + هدف الفحص لتجنب التباس «localhost مقابل ربط LAN» وعدم تطابق الملفات الشخصية.
- `gateway status` يتضمن آخر سطر خطأ من Gateway عندما تبدو الخدمة تعمل لكن المنفذ مغلق.
- `logs` يتتبع سجل ملفات Gateway عبر RPC (لا حاجة إلى `tail`/`grep` يدويًا).
- إذا كُشفت خدمات شبيهة بالبوابة، يحذّر CLI ما لم تكن خدمات ملفات OpenClaw الشخصية.
  ما زلنا نوصي بـ **بوابة واحدة لكل جهاز** لمعظم الإعدادات؛ استخدم ملفات/منافذ معزولة للتكرار أو روبوت إنقاذ. انظر [بوابات متعددة](/gateway/multiple-gateways).
  - التنظيف: `openclaw gateway uninstall` (الخدمة الحالية) و`openclaw doctor` (ترحيلات قديمة).
- `gateway install` لا يقوم بأي إجراء عند كونه مثبتًا بالفعل؛ استخدم `openclaw gateway install --force` لإعادة التثبيت (تغييرات الملف الشخصي/البيئة/المسار).

تطبيق mac المُضمَّن:

- يمكن لـ OpenClaw.app تجميع مرحّل Gateway قائم على Node وتثبيت LaunchAgent لكل مستخدم بعلامة
  `bot.molt.gateway` (أو `bot.molt.<profile>`؛ وتُفك تحميل العلامات القديمة `com.openclaw.*` بشكل نظيف).
- لإيقافه بشكل نظيف، استخدم `openclaw gateway stop` (أو `launchctl bootout gui/$UID/bot.molt.gateway`).
- لإعادة التشغيل، استخدم `openclaw gateway restart` (أو `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - يعمل `launchctl` فقط إذا كان LaunchAgent مثبتًا؛ وإلا فاستخدم `openclaw gateway install` أولًا.
  - استبدل العلامة بـ `bot.molt.<profile>` عند تشغيل ملف شخصي مُسمّى.

## الإشراف (وحدة systemd للمستخدم)

يثبّت OpenClaw **خدمة systemd للمستخدم** افتراضيًا على Linux/WSL2. نوصي
بخدمات المستخدم للأجهزة أحادية المستخدم (بيئة أبسط، تهيئة لكل مستخدم).
استخدم **خدمة نظام** للخوادم متعددة المستخدمين أو الدائمة التشغيل (لا حاجة إلى lingering، إشراف مشترك).

يكتب `openclaw gateway install` وحدة المستخدم. يقوم `openclaw doctor` بتدقيق
الوحدة ويمكنه تحديثها لتطابق الافتراضيات الموصى بها الحالية.

أنشئ `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

فعّل lingering (مطلوب كي تبقى خدمة المستخدم بعد تسجيل الخروج/الخمول):

```
sudo loginctl enable-linger youruser
```

تشغيل الإعداد الأولي ينفّذ هذا على Linux/WSL2 (قد يطلب sudo؛ ويكتب `/var/lib/systemd/linger`).
ثم فعّل الخدمة:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**بديل (خدمة نظام)** — للخوادم الدائمة التشغيل أو متعددة المستخدمين، يمكنك
تثبيت وحدة **نظام** systemd بدل وحدة المستخدم (لا حاجة إلى lingering).
أنشئ `/etc/systemd/system/openclaw-gateway[-<profile>].service` (انسخ الوحدة أعلاه،
بدّل `WantedBy=multi-user.target`، واضبط `User=` + `WorkingDirectory=`)، ثم:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

يجب أن تستخدم تثبيتات Windows **WSL2** وتتبع قسم systemd الخاص بـ Linux أعلاه.

## فحوصات تشغيلية

- الحيوية: افتح WS وأرسل `req:connect` → توقّع `res` مع `payload.type="hello-ok"` (مع لقطة).
- الجاهزية: استدعِ `health` → توقّع `ok: true` وقناة مرتبطة في `linkChannel` (عند الاقتضاء).
- التصحيح: اشترك في أحداث `tick` و`presence`؛ تأكّد من أن `status` يُظهر عمر الارتباط/التوثيق؛ وتُظهر إدخالات الحضور مضيف Gateway والعملاء المتصلين.

## ضمانات السلامة

- افترض بوابة واحدة لكل مضيف افتراضيًا؛ إذا شغّلت ملفات متعددة، اعزل المنافذ/الحالة واستهدف النسخة الصحيحة.
- لا يوجد مسار بديل لاتصالات Baileys المباشرة؛ إذا كانت Gateway متوقفة، تفشل عمليات الإرسال سريعًا.
- تُرفَض الإطارات الأولى غير المتصلة أو JSON المشوّه ويُغلق المقبس.
- إيقاف رشيق: بث حدث `shutdown` قبل الإغلاق؛ يجب على العملاء التعامل مع الإغلاق + إعادة الاتصال.

## أدوات CLI المساعدة

- `openclaw gateway health|status` — طلب الصحة/الحالة عبر WS الخاص بـ Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — إرسال عبر Gateway (مُعاد التنفيذ لـ WhatsApp).
- `openclaw agent --message "hi" --to <num>` — تشغيل دور وكيل (ينتظر النهائي افتراضيًا).
- `openclaw gateway call <method> --params '{"k":"v"}'` — مستدعي أساليب خام للتصحيح.
- `openclaw gateway stop|restart` — إيقاف/إعادة تشغيل خدمة Gateway الخاضعة للإشراف (launchd/systemd).
- تفترض أوامر Gateway المساعدة وجود بوابة تعمل على `--url`؛ ولم تعد تُنشئ واحدة تلقائيًا.

## إرشادات الترحيل

- أوقف استخدام `openclaw gateway` ومنفذ التحكم TCP القديم.
- حدّث العملاء للتحدث ببروتوكول WS مع اتصال إلزامي وحضور مُنظَّم.
