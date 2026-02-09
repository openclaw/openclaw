---
summary: "CLI ‏OpenClaw Gateway‏ (`openclaw gateway`) — تشغيل البوابات والاستعلام عنها واكتشافها"
read_when:
  - تشغيل Gateway من خلال CLI (للتطوير أو الخوادم)
  - استكشاف أخطاء مصادقة Gateway وأوضاع الربط والاتصال وإصلاحها
  - اكتشاف البوابات عبر Bonjour (شبكة محلية + tailnet)
title: "gateway"
---

# Gateway CLI

يُعد Gateway خادم WebSocket الخاص بـ OpenClaw (القنوات، العُقد، الجلسات، الخطافات).

الأوامر الفرعية في هذه الصفحة تقع تحت `openclaw gateway …`.

مستندات ذات صلة:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## تشغيل Gateway

تشغيل عملية Gateway محلية:

```bash
openclaw gateway
```

الاسم المستعار للقدمية:

```bash
openclaw gateway run
```

ملاحظات:

- افتراضيًا، يرفض Gateway البدء ما لم يتم تعيين `gateway.mode=local` في `~/.openclaw/openclaw.json`. استخدم `--allow-unconfigured` للتشغيل المؤقت/التطويري.
- يتم حظر الربط خارج loopback دون مصادقة (حاجز أمان).
- يُطلق `SIGUSR1` إعادة تشغيل داخل العملية عند التفويض (فعّل `commands.restart` أو استخدم أداة/تهيئة gateway apply/update).
- تُوقِف معالجات `SIGINT`/`SIGTERM` عملية gateway، لكنها لا تستعيد أي حالة مخصّصة للطرفية. إذا لففت CLI بواجهة TUI أو إدخال بنمط raw، فأعِد الطرفية قبل الخروج.

### الخيارات

- `--port <port>`: منفذ WebSocket (القيمة الافتراضية تأتي من التهيئة/متغيرات البيئة؛ غالبًا `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: وضع ربط المستمع.
- `--auth <token|password>`: تجاوز وضع المصادقة.
- `--token <token>`: تجاوز الرمز المميّز (ويعيّن أيضًا `OPENCLAW_GATEWAY_TOKEN` للعملية).
- `--password <password>`: تجاوز كلمة المرور (ويعيّن أيضًا `OPENCLAW_GATEWAY_PASSWORD` للعملية).
- `--tailscale <off|serve|funnel>`: إتاحة Gateway عبر Tailscale.
- `--tailscale-reset-on-exit`: إعادة ضبط تهيئة Tailscale serve/funnel عند الإيقاف.
- `--allow-unconfigured`: السماح ببدء gateway دون `gateway.mode=local` في التهيئة.
- `--dev`: إنشاء تهيئة تطوير + مساحة عمل إن لم تكن موجودة (يتجاوز BOOTSTRAP.md).
- `--reset`: إعادة ضبط تهيئة التطوير + بيانات الاعتماد + الجلسات + مساحة العمل (يتطلب `--dev`).
- `--force`: إنهاء أي مستمع موجود على المنفذ المحدد قبل البدء.
- `--verbose`: سجلات تفصيلية.
- `--claude-cli-logs`: عرض سجلات claude-cli فقط في وحدة التحكم (وتمكين stdout/stderr الخاصة به).
- `--ws-log <auto|full|compact>`: نمط سجل websocket (الافتراضي `auto`).
- `--compact`: اسم بديل لـ `--ws-log compact`.
- `--raw-stream`: تسجيل أحداث تدفق النموذج الخام إلى jsonl.
- `--raw-stream-path <path>`: مسار jsonl للتدفق الخام.

## الاستعلام عن Gateway قيد التشغيل

تستخدم جميع أوامر الاستعلام WebSocket RPC.

أوضاع الإخراج:

- الافتراضي: قابل للقراءة البشرية (مُلوَّن في TTY).
- `--json`: JSON قابل للقراءة الآلية (من دون تنسيق/مؤشر دوران).
- `--no-color` (أو `NO_COLOR=1`): تعطيل ANSI مع الحفاظ على التخطيط البشري.

الخيارات المشتركة (حيثما كانت مدعومة):

- `--url <url>`: عنوان URL لـ WebSocket الخاص بـ Gateway.
- `--token <token>`: رمز Gateway.
- `--password <password>`: كلمة مرور Gateway.
- `--timeout <ms>`: مهلة/ميزانية (تختلف حسب الأمر).
- `--expect-final`: الانتظار حتى استجابة «نهائية» (استدعاءات الوكيل).

ملاحظة: عند تعيين `--url`، لا يعود CLI إلى التهيئة أو بيانات الاعتماد من البيئة.
مرِّر `--token` أو `--password` صراحةً. غياب بيانات اعتماد صريحة يُعد خطأً.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

يعرض `gateway status` خدمة Gateway ‏(launchd/systemd/schtasks) إضافةً إلى فحص RPC اختياري.

```bash
openclaw gateway status
openclaw gateway status --json
```

الخيارات:

- `--url <url>`: تجاوز عنوان URL للفحص.
- `--token <token>`: مصادقة الرمز المميّز للفحص.
- `--password <password>`: مصادقة كلمة المرور للفحص.
- `--timeout <ms>`: مهلة الفحص (الافتراضي `10000`).
- `--no-probe`: تخطي فحص RPC (عرض الخدمة فقط).
- `--deep`: فحص خدمات مستوى النظام أيضًا.

### `gateway probe`

يُعد `gateway probe` أمر «تصحيح كل شيء». وهو يفحص دائمًا:

- gateway البعيد المُهيّأ لديك (إن كان مضبوطًا)، و
- localhost (loopback) **حتى إذا كان البعيد مُهيّأ**.

إذا كانت عدة بوابات قابلة للوصول، فإنه يطبعها جميعًا. تُدعَم عدة بوابات عند استخدام ملفات تعريف/منافذ معزولة (مثل روبوت إنقاذ)، لكن معظم عمليات التثبيت لا تزال تشغّل بوابة واحدة.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### البعيد عبر SSH (تماثل تطبيق Mac)

يستخدم وضع تطبيق macOS «Remote over SSH» إعادة توجيه منفذ محلية بحيث يصبح gateway البعيد (الذي قد يكون مربوطًا على loopback فقط) متاحًا على `ws://127.0.0.1:<port>`.

المكافئ عبر CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

الخيارات:

- `--ssh <target>`: ‏`user@host` أو `user@host:port` (المنفذ الافتراضي `22`).
- `--ssh-identity <path>`: ملف الهوية.
- `--ssh-auto`: اختيار أول مضيف Gateway مُكتشَف كهدف SSH (LAN/WAB فقط).

التهيئة (اختيارية، تُستخدم كقيم افتراضية):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

مساعد RPC منخفض المستوى.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## إدارة خدمة Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

ملاحظات:

- يدعم `gateway install` ‏`--port`، ‏`--runtime`، ‏`--token`، ‏`--force`، ‏`--json`.
- تقبل أوامر دورة الحياة `--json` لأغراض البرمجة النصية.

## اكتشاف البوابات (Bonjour)

يفحص `gateway discover` إشارات Gateway ‏(`_openclaw-gw._tcp`).

- Multicast DNS-SD: ‏`local.`
- Unicast DNS-SD ‏(Wide-Area Bonjour): اختر نطاقًا (مثال: `openclaw.internal.`) وأعِد إعداد Split DNS + خادم DNS؛ راجع [/gateway/bonjour](/gateway/bonjour)

تعلن فقط البوابات التي فُعِّل لديها اكتشاف Bonjour (افتراضيًا) عن الإشارة.

تتضمن سجلات اكتشاف Wide-Area (TXT):

- `role` (تلميح دور gateway)
- `transport` (تلميح النقل، مثل `gateway`)
- `gatewayPort` (منفذ WebSocket، غالبًا `18789`)
- `sshPort` (منفذ SSH؛ الافتراضي `22` إذا لم يكن موجودًا)
- `tailnetDns` (اسم مضيف MagicDNS عند التوفر)
- `gatewayTls` / `gatewayTlsSha256` (تمكين TLS + بصمة الشهادة)
- `cliPath` (تلميح اختياري للتثبيتات البعيدة)

### `gateway discover`

```bash
openclaw gateway discover
```

الخيارات:

- `--timeout <ms>`: مهلة لكل أمر (تصفّح/حل)؛ الافتراضي `2000`.
- `--json`: إخراج قابل للقراءة الآلية (ويعطّل أيضًا التنسيق/مؤشر الدوران).

أمثلة:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
