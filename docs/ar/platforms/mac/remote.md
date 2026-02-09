---
summary: "تدفّق تطبيق macOS للتحكّم في Gateway لـ OpenClaw عن بُعد عبر SSH"
read_when:
  - إعداد أو تصحيح أخطاء التحكّم عن بُعد في mac
title: "التحكم عن بعد"
---

# OpenClaw عن بُعد (macOS ⇄ مضيف بعيد)

يتيح هذا التدفّق لتطبيق macOS العمل كجهاز تحكّم عن بُعد كامل لـ Gateway لـ OpenClaw يعمل على مضيف آخر (سطح مكتب/خادم). إنها ميزة التطبيق **Remote over SSH** (التشغيل عن بُعد). جميع الميزات—فحوصات السلامة، وتمرير Voice Wake، وWeb Chat—تعيد استخدام تهيئة SSH نفسها من _Settings → General_.

## أوضاع

- **محلي (هذا الـ Mac)**: كل شيء يعمل على الحاسوب المحمول. لا يوجد SSH.
- **Remote over SSH (افتراضي)**: تُنفَّذ أوامر OpenClaw على المضيف البعيد. يفتح تطبيق mac اتصال SSH باستخدام `-o BatchMode` بالإضافة إلى الهوية/المفتاح الذي تختاره وتحويل منفذ محلي.
- **Remote direct (ws/wss)**: بدون نفق SSH. يتصل تطبيق mac مباشرة بعنوان URL الخاص بالـ Gateway (على سبيل المثال عبر Tailscale Serve أو وكيل عكسي HTTPS عام).

## نواقل النقل عن بُعد

الوضع البعيد يدعم نقلتين:

- **نفق SSH** (افتراضي): يستخدم `ssh -N -L ...` لتمرير منفذ الـ Gateway إلى localhost. سيرى الـ Gateway عنوان IP للعُقدة على أنه `127.0.0.1` لأن النفق هو loopback.
- **مباشر (ws/wss)**: يتصل مباشرة بعنوان URL الخاص بالـ Gateway. يرى الـ Gateway عنوان IP الحقيقي للعميل.

## المتطلبات المسبقة على المضيف البعيد

1. تثبيت Node + pnpm وبناء/تثبيت CLI الخاص بـ OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. التأكد من أن `openclaw` موجود على PATH للأصداف غير التفاعلية (أنشئ رابطًا رمزيًا داخل `/usr/local/bin` أو `/opt/homebrew/bin` عند الحاجة).
3. فتح SSH باستخدام مصادقة المفاتيح. نوصي بعناوين IP الخاصة بـ **Tailscale** لضمان قابلية وصول مستقرة خارج الشبكة المحلية.

## إعداد تطبيق macOS

1. افتح _Settings → General_.
2. ضمن **OpenClaw runs**، اختر **Remote over SSH** واضبط:
   - **Transport**: **SSH tunnel** أو **Direct (ws/wss)**.
   - **SSH target**: `user@host` (اختياري `:port`).
     - إذا كان الـ Gateway على الشبكة المحلية نفسها ويعلن عبر Bonjour، اختره من قائمة الاكتشاف لملء هذا الحقل تلقائيًا.
   - **Gateway URL** (Direct فقط): `wss://gateway.example.ts.net` (أو `ws://...` للمحلي/الشبكة المحلية).
   - **Identity file** (متقدّم): مسار مفتاحك.
   - **Project root** (متقدّم): مسار المستودع البعيد المستخدم للأوامر.
   - **CLI path** (متقدّم): مسار اختياري لمدخل/ثنائي `openclaw` قابل للتشغيل (يُملأ تلقائيًا عند الإعلان).
3. انقر **Test remote**. يشير النجاح إلى أن `openclaw status --json` البعيد يعمل بشكل صحيح. عادةً ما تعني الإخفاقات مشاكل PATH/CLI؛ خروج 127 يعني أن CLI غير موجود على المضيف البعيد.
4. ستعمل فحوصات السلامة وWeb Chat الآن تلقائيًا عبر نفق SSH هذا.

## Web Chat

- **نفق SSH**: يتصل Web Chat بالـ Gateway عبر منفذ التحكم WebSocket المُمرَّر (الافتراضي 18789).
- **مباشر (ws/wss)**: يتصل Web Chat مباشرة بعنوان URL المُهيّأ للـ Gateway.
- لم يعد هناك خادم HTTP منفصل لـ WebChat.

## الأذونات

- يحتاج المضيف البعيد إلى موافقات TCC نفسها كما في المحلي (Automation، Accessibility، Screen Recording، Microphone، Speech Recognition، Notifications). شغّل التهيئة الأولية على ذلك الجهاز لمنحها مرة واحدة.
- تعلن العُقد حالة أذوناتها عبر `node.list` / `node.describe` لكي تعرف الوكلاء ما هو المتاح.

## ملاحظات أمنية

- فضّل الربط على loopback في المضيف البعيد والاتصال عبر SSH أو Tailscale.
- إذا ربطت الـ Gateway بواجهة غير loopback، فاشترط مصادقة برمز/كلمة مرور.
- راجع [Security](/gateway/security) و[Tailscale](/gateway/tailscale).

## تدفّق تسجيل الدخول إلى WhatsApp (عن بُعد)

- شغّل `openclaw channels login --verbose` **على المضيف البعيد**. امسح رمز QR باستخدام WhatsApp على هاتفك.
- أعد تشغيل تسجيل الدخول على ذلك المضيف إذا انتهت صلاحية المصادقة. ستُظهر فحوصات السلامة مشاكل الارتباط.

## استكشاف الأخطاء وإصلاحها

- **exit 127 / not found**: `openclaw` غير موجود على PATH للأصداف غير المُسجِّلة للدخول. أضِفه إلى `/etc/paths`، أو ملف rc للصدفة، أو أنشئ رابطًا رمزيًا داخل `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: تحقّق من إمكانية الوصول عبر SSH، وPATH، وأن Baileys مسجّل الدخول (`openclaw status --json`).
- **Web Chat متوقّف**: أكّد أن الـ Gateway يعمل على المضيف البعيد وأن المنفذ المُمرَّر يطابق منفذ WS الخاص بالـ Gateway؛ تتطلّب الواجهة اتصال WS سليمًا.
- **Node IP يظهر 127.0.0.1**: هذا متوقّع مع نفق SSH. بدّل **Transport** إلى **Direct (ws/wss)** إذا أردت أن يرى الـ Gateway عنوان IP الحقيقي للعميل.
- **Voice Wake**: تُمرَّر عبارات التشغيل تلقائيًا في الوضع البعيد؛ لا حاجة إلى مُمرِّر منفصل.

## أصوات الإشعارات

اختر الأصوات لكل إشعار من السكربتات باستخدام `openclaw` و`node.invoke`، على سبيل المثال:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

لم يعد هناك مفتاح «صوت افتراضي» عام في التطبيق؛ يختار المستدعون صوتًا (أو بدون صوت) لكل طلب.
