---
summary: "واجهة تحكّم قائمة على المتصفح لـ Gateway (الدردشة، العُقد، التهيئة)"
read_when:
  - تريد تشغيل Gateway من المتصفح
  - تريد وصول Tailnet دون أنفاق SSH
title: "واجهة التحكّم"
---

# واجهة التحكّم (المتصفح)

واجهة التحكّم هي تطبيق صفحة واحدة صغير مبني باستخدام **Vite + Lit** ويتم تقديمه بواسطة Gateway:

- الافتراضي: `http://<host>:18789/`
- بادئة اختيارية: عيّن `gateway.controlUi.basePath` (على سبيل المثال: `/openclaw`)

يتواصل مباشرةً مع **WebSocket الخاص بـ Gateway** على المنفذ نفسه.

## الفتح السريع (محلي)

إذا كان Gateway يعمل على الكمبيوتر نفسه، افتح:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (أو [http://localhost:18789/](http://localhost:18789/))

إذا فشل تحميل الصفحة، ابدأ تشغيل Gateway أولًا: `openclaw gateway`.

يتم توفير المصادقة أثناء مصافحة WebSocket عبر:

- `connect.params.auth.token`
- `connect.params.auth.password`
  تتيح لوحة إعدادات لوحة التحكّم تخزين رمز مميّز؛ ولا يتم حفظ كلمات المرور.
  يقوم معالج التهيئة الأولية بإنشاء رمز Gateway افتراضيًا، لذا الصقه هنا عند الاتصال الأول.

## إقران الجهاز (الاتصال الأول)

عند الاتصال بواجهة التحكّم من متصفح أو جهاز جديد، يتطلّب Gateway
**موافقة إقران لمرة واحدة** — حتى لو كنت على Tailnet نفسه
مع `gateway.auth.allowTailscale: true`. هذا إجراء أمني لمنع
الوصول غير المصرّح به.

**ما ستراه:** "disconnected (1008): pairing required"

**للموافقة على الجهاز:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

بعد الموافقة، يتم تذكّر الجهاز ولن يتطلّب إعادة الموافقة إلا إذا
قمت بإلغائها باستخدام `openclaw devices revoke --device <id> --role <role>`. راجع
[Devices CLI](/cli/devices) لتدوير الرموز وإلغائها.

**ملاحظات:**

- الاتصالات المحلية (`127.0.0.1`) تتم الموافقة عليها تلقائيًا.
- الاتصالات عن بعد (الشبكة المحلية، تايلنيت، إلخ) يتطلب موافقة صريحة.
- يقوم كل ملف تعريف متصفح بإنشاء معرّف جهاز فريد، لذا فإن تبديل المتصفحات أو
  مسح بيانات المتصفح سيتطلّب إعادة الإقران.

## ما الذي يمكنها فعله (حاليًا)

- الدردشة مع النموذج عبر Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- بثّ استدعاءات الأدوات + بطاقات إخراج الأدوات الحية في الدردشة (أحداث الوكيل)
- القنوات: حالة قنوات WhatsApp/Telegram/Discord/Slack + قنوات الإضافات (Mattermost، إلخ) + تسجيل الدخول عبر QR + تهيئة لكل قناة (`channels.status`, `web.login.*`, `config.patch`) حالة + تسجيل الدخول QR + لكل قناة تهيئة (`channels.status`, `web.login.*`, `config.patch`)
- المثيلات: قائمة الحضور + تحديث (`system-presence`)
- الجلسات: قائمة + تجاوزات التفكير/الوضع المطوّل لكل جلسة (`sessions.list`, `sessions.patch`)
- مهام Cron: سرد/إضافة/تشغيل/تمكين/تعطيل + سجل التشغيل (`cron.*`)
- Skills: الحالة، تمكين/تعطيل، تثبيت، تحديثات مفاتيح API (`skills.*`)
- العُقد: قائمة + القدرات (`node.list`)
- موافقات التنفيذ: تحرير قوائم السماح لـ Gateway أو العُقد + طلب سياسة لـ `exec host=gateway/node` (`exec.approvals.*`)
- التهيئة: عرض/تحرير `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- التهيئة: تطبيق + إعادة تشغيل مع التحقّق (`config.apply`) وإيقاظ آخر جلسة نشطة
- تتضمّن عمليات كتابة التهيئة حارس تجزئة أساسي لمنع الكتابة فوق تعديلات متزامنة
- مخطط التهيئة + عرض النماذج (`config.schema`، بما في ذلك مخططات الإضافات والقنوات)؛ يظل محرّر JSON الخام متاحًا
- التصحيح: لقطات الحالة/السلامة/النماذج + سجل الأحداث + استدعاءات RPC يدوية (`status`, `health`, `models.list`)
- السجلات: تتبّع مباشر لسجلات ملفات Gateway مع التصفية/التصدير (`logs.tail`)
- التحديث: تشغيل تحديث حزمة/مستودع git + إعادة تشغيل (`update.run`) مع تقرير إعادة التشغيل

ملاحظات لوحة مهام Cron:

- للمهام المعزولة، يكون التسليم افتراضيًا على إعلان ملخّص. يمكنك التبديل إلى «بدون» إذا أردت تشغيلًا داخليًا فقط.
- تظهر حقول القناة/الهدف عند اختيار «إعلان».

## سلوك الدردشة

- `chat.send` **غير حاجز**: يتم الإقرار فورًا بـ `{ runId, status: "started" }` ويتم بثّ الاستجابة عبر أحداث `chat`.
- إعادة الإرسال باستخدام نفس `idempotencyKey` تُرجع `{ status: "in_flight" }` أثناء التشغيل، و`{ status: "ok" }` بعد الاكتمال.
- `chat.inject` يُلحق ملاحظة مساعد بنص الجلسة ويبث حدث `chat` لتحديثات واجهة المستخدم فقط (من دون تشغيل وكيل، ومن دون تسليم إلى قناة).
- الإيقاف:
  - انقر **Stop** (يستدعي `chat.abort`)
  - اكتب `/stop` (أو `stop|esc|abort|wait|exit|interrupt`) للإلغاء خارج النطاق
  - يدعم `chat.abort` `{ sessionKey }` (من دون `runId`) لإلغاء جميع عمليات التشغيل النشطة لتلك الجلسة

## الوصول عبر Tailnet (موصى به)

### Tailscale Serve المدمج (المفضّل)

أبقِ Gateway على local loopback ودع Tailscale Serve يقوم بالوساطة عبر HTTPS:

```bash
openclaw gateway --tailscale serve
```

افتح:

- `https://<magicdns>/` (أو `gateway.controlUi.basePath` الذي قمت بتهيئته)

افتراضيًا، يمكن لمتطلبات Serve المصادقة عبر ترويسات هوية Tailscale
(`tailscale-user-login`) عندما يكون `gateway.auth.allowTailscale` هو `true`. يقوم OpenClaw
بالتحقق من الهوية عبر حل عنوان `x-forwarded-for` باستخدام
`tailscale whois` ومطابقته مع الترويسة، ولا يقبل ذلك إلا عندما
يصل الطلب إلى local loopback مع ترويسات `x-forwarded-*` الخاصة بـ Tailscale. عيّن
`gateway.auth.allowTailscale: false` (أو افرض `gateway.auth.mode: "password"`)
إذا أردت اشتراط رمز/كلمة مرور حتى لحركة Serve.

### الربط بـ tailnet + رمز

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

ثم افتح:

- `http://<tailscale-ip>:18789/` (أو `gateway.controlUi.basePath` الذي قمت بتهيئته)

الصق الرمز في إعدادات واجهة المستخدم (يُرسل كـ `connect.params.auth.token`).

## HTTP غير الآمن

إذا فتحت لوحة التحكّم عبر HTTP عادي (`http://<lan-ip>` أو `http://<tailscale-ip>`),
فإن المتصفح يعمل في **سياق غير آمن** ويمنع WebCrypto. افتراضيًا،
يقوم OpenClaw **بحظر** اتصالات واجهة التحكّم دون هوية جهاز.

**الإصلاح الموصى به:** استخدم HTTPS (Tailscale Serve) أو افتح الواجهة محليًا:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (على مضيف Gateway)

**مثال خفض الأمان (رمز فقط عبر HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

يؤدي هذا إلى تعطيل هوية الجهاز + الإقران لواجهة التحكّم (حتى عبر HTTPS). استخدمه
فقط إذا كنت تثق بالشبكة.

راجع [Tailscale](/gateway/tailscale) لإرشادات إعداد HTTPS.

## بناء الواجهة

يقدّم Gateway ملفات ثابتة من `dist/control-ui`. قم ببنائها باستخدام:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

قاعدة مطلقة اختيارية (عندما تريد عناوين أصول ثابتة):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

للتطوير المحلي (خادم تطوير منفصل):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

ثم وجّه الواجهة إلى عنوان Gateway WS (على سبيل المثال: `ws://127.0.0.1:18789`).

## التصحيح/الاختبار: خادم التطوير + Gateway بعيد

واجهة التحكّم هي ملفات ثابتة؛ وهدف WebSocket قابل للتهيئة ويمكن أن
يختلف عن أصل HTTP. هذا مفيد عندما تريد خادم تطوير Vite محليًا
بينما يعمل Gateway في مكان آخر.

1. ابدأ خادم تطوير الواجهة: `pnpm ui:dev`
2. افتح عنوان URL مثل:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

مصادقة لمرة واحدة اختيارية (إن لزم):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

ملاحظات:

- يتم تخزين `gatewayUrl` في localStorage بعد التحميل وإزالته من عنوان URL.
- يتم تخزين `token` في localStorage؛ بينما يُحتفظ بـ `password` في الذاكرة فقط.
- عند تعيين `gatewayUrl`، لا تعود الواجهة إلى بيانات اعتماد التهيئة أو البيئة.
  قدّم `token` (أو `password`) صراحةً. يُعد غياب بيانات اعتماد صريحة خطأً.
- استخدم `wss://` عندما يكون Gateway خلف TLS (Tailscale Serve، وكيل HTTPS، إلخ).
- لا يُقبل `gatewayUrl` إلا في نافذة من المستوى الأعلى (غير مضمّنة) لمنع هجمات النقر الخادع.
- لإعدادات التطوير عبر أصول متعددة (على سبيل المثال: `pnpm ui:dev` إلى Gateway بعيد)، أضِف أصل الواجهة
  إلى `gateway.controlUi.allowedOrigins`.

مثال:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

تفاصيل إعداد الوصول البعيد: [الوصول البعيد](/gateway/remote).
