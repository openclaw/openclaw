---
summary: "تطبيق OpenClaw المُرافِق على macOS (شريط القوائم + وسيط Gateway)"
read_when:
  - تنفيذ ميزات تطبيق macOS
  - تغيير دورة حياة Gateway أو ربط العُقد على macOS
title: "تطبيق macOS"
---

# تطبيق OpenClaw المُرافِق على macOS (شريط القوائم + وسيط Gateway)

تطبيق macOS هو **التطبيق المُرافِق في شريط القوائم** لـ OpenClaw. يتولى إدارة الأذونات،
ويدير/يرتبط بـ Gateway محليًا (عبر launchd أو يدويًا)، ويعرض قدرات macOS للوكيل بوصفها عُقدة.

## ماذا يفعل

- يعرض الإشعارات الأصلية والحالة في شريط القوائم.
- يتولى مطالبات TCC (الإشعارات، إمكانية الوصول، تسجيل الشاشة، الميكروفون،
  التعرّف على الكلام، الأتمتة/AppleScript).
- يشغّل Gateway أو يتصل به (محليًا أو عن بُعد).
- يعرّض أدوات خاصة بـ macOS (Canvas، الكاميرا، تسجيل الشاشة، `system.run`).
- يبدأ خدمة مضيف العُقدة المحلية في وضع **remote** (عبر launchd)، ويوقفها في وضع **local**.
- يستضيف اختياريًا **PeekabooBridge** لأتمتة واجهة المستخدم.
- يثبّت CLI العام (`openclaw`) عبر npm/pnpm عند الطلب (لا يُنصح باستخدام bun لبيئة تشغيل Gateway).

## الوضع المحلي مقابل البعيد

- **Local** (الافتراضي): يرتبط التطبيق بـ Gateway محلي قيد التشغيل إن وُجد؛
  وإلا فإنه يفعّل خدمة launchd عبر `openclaw gateway install`.
- **Remote**: يتصل التطبيق بـ Gateway عبر SSH/Tailscale ولا يبدأ أي عملية محلية.
  يبدأ التطبيق **خدمة مضيف العُقدة** المحلية لكي يتمكن Gateway البعيد من الوصول إلى هذا الجهاز.
  لا يقوم التطبيق بإنشاء Gateway كعملية فرعية.

## التحكم عبر Launchd

يدير التطبيق LaunchAgent لكل مستخدم بعلامة `bot.molt.gateway`
(أو `bot.molt.<profile>` عند استخدام `--profile`/`OPENCLAW_PROFILE`؛ ولا يزال `com.openclaw.*` القديم يُفَرَّغ).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

استبدل العلامة بـ `bot.molt.<profile>` عند تشغيل ملف تعريف مُسمّى.

إذا لم يكن LaunchAgent مُثبّتًا، فقم بتمكينه من التطبيق أو شغّل
`openclaw gateway install`.

## قدرات العُقدة (mac)

يعرض تطبيق macOS نفسه كعُقدة. أوامر شائعة:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- الكاميرا: `camera.snap`, `camera.clip`
- الشاشة: `screen.record`
- النظام: `system.run`, `system.notify`

تُبلّغ العُقدة عن خريطة `permissions` بحيث يمكن للوكلاء تقرير ما هو المسموح.

خدمة العُقدة + IPC الخاص بالتطبيق:

- عندما تكون خدمة مضيف العُقدة بدون واجهة تعمل (وضع remote)، فإنها تتصل بـ Gateway WS كعُقدة.
- `system.run` يُنفَّذ داخل تطبيق macOS (سياق UI/TCC) عبر مقبس Unix محلي؛ وتبقى المطالبات والمخرجات داخل التطبيق.

مخطط (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## موافقات التنفيذ (system.run)

يتم التحكم في `system.run` عبر **موافقات التنفيذ** في تطبيق macOS (الإعدادات → موافقات التنفيذ).
تُخزَّن إعدادات الأمان + السؤال + قائمة السماح محليًا على الجهاز في:

```
~/.openclaw/exec-approvals.json
```

مثال:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

ملاحظات:

- إدخالات `allowlist` هي أنماط glob لمسارات الثنائيات بعد حلّها.
- اختيار «السماح دائمًا» في المطالبة يضيف ذلك الأمر إلى قائمة السماح.
- يتم ترشيح تجاوزات متغيرات البيئة `system.run` (إسقاط `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) ثم دمجها مع بيئة التطبيق.

## الروابط العميقة

يسجّل التطبيق مخطط URL ‏`openclaw://` للإجراءات المحلية.

### `openclaw://agent`

يُشغّل طلب `agent` إلى Gateway.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

معلمات الاستعلام:

- `message` (مطلوب)
- `sessionKey` (اختياري)
- `thinking` (اختياري)
- `deliver` / `to` / `channel` (اختياري)
- `timeoutSeconds` (اختياري)
- `key` (مفتاح وضع غير مراقَب اختياري)

السلامة:

- بدون `key`، يطلب التطبيق التأكيد.
- مع `key` صالح، يكون التشغيل غير مراقَب (مقصود للأتمتات الشخصية).

## تدفق أونبواردك (نموذجي)

1. تثبيت وتشغيل **OpenClaw.app**.
2. إكمال قائمة التحقق من الأذونات (مطالبات TCC).
3. التأكد من تفعيل وضع **Local** وأن Gateway يعمل.
4. تثبيت CLI إذا كنت تريد الوصول عبر الطرفية.

## سير عمل البناء والتطوير (محلي)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (أو Xcode)
- حزم التطبيق: `scripts/package-mac-app.sh`

## تصحيح اتصال Gateway (CLI على macOS)

استخدم CLI الخاص بالتصحيح لاختبار نفس مصافحة WebSocket والاكتشاف في Gateway
الذي يستخدمه تطبيق macOS، دون تشغيل التطبيق.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

خيارات الاتصال:

- `--url <ws://host:port>`: تجاوز التهيئة
- `--mode <local|remote>`: الحل من التهيئة (الافتراضي: التهيئة أو المحلي)
- `--probe`: فرض فحص صحة جديد
- `--timeout <ms>`: مهلة الطلب (الافتراضي: `15000`)
- `--json`: مخرجات مُهيكلة للمقارنة

خيارات الاكتشاف:

- `--include-local`: تضمين Gateways التي قد تُرشَّح بوصفها «local»
- `--timeout <ms>`: نافذة الاكتشاف الكلية (الافتراضي: `2000`)
- `--json`: مخرجات مُهيكلة للمقارنة

نصيحة: قارن مقابل `openclaw gateway discover --json` لمعرفة ما إذا كان
مسار الاكتشاف في تطبيق macOS (NWBrowser + احتياطي DNS‑SD لشبكة tailnet) يختلف عن
اكتشاف Node CLI المعتمد على `dns-sd`.

## توصيلات الاتصال البعيد (أنفاق SSH)

عندما يعمل تطبيق macOS في وضع **Remote**، فإنه يفتح نفق SSH بحيث تتمكن مكوّنات
واجهة المستخدم المحلية من التحدث إلى Gateway بعيد كما لو كان على localhost.

### نفق التحكم (منفذ WebSocket لـ Gateway)

- **الغرض:** فحوصات الصحة، الحالة، الدردشة عبر الويب، التهيئة، واستدعاءات طبقة التحكم الأخرى.
- **المنفذ المحلي:** منفذ Gateway (الافتراضي `18789`)، ثابت دائمًا.
- **المنفذ البعيد:** نفس منفذ Gateway على المضيف البعيد.
- **السلوك:** لا يوجد منفذ محلي عشوائي؛ يعيد التطبيق استخدام نفق سليم موجود
  أو يعيد تشغيله عند الحاجة.
- **شكل SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` مع BatchMode +
  ExitOnForwardFailure + خيارات keepalive.
- **الإبلاغ عن IP:** يستخدم نفق SSH حلقة الرجوع، لذا سيرى Gateway عنوان IP للعُقدة
  على أنه `127.0.0.1`. استخدم نقل **Direct (ws/wss)** إذا أردت ظهور عنوان IP الحقيقي
  للعميل (انظر [الوصول البعيد على macOS](/platforms/mac/remote)).

لخطوات الإعداد، راجع [الوصول البعيد على macOS](/platforms/mac/remote). ولتفاصيل
البروتوكول، راجع [بروتوكول Gateway](/gateway/protocol).

## مستندات ذات صلة

- [دليل تشغيل Gateway](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [أذونات macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
