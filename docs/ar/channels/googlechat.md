---
summary: "حالة دعم تطبيق Google Chat، والقدرات، والتهيئة"
read_when:
  - العمل على ميزات قناة Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

الحالة: جاهز للرسائل المباشرة (DMs) + المساحات عبر Webhooks الخاصة بـ Google Chat API (HTTP فقط).

## إعداد سريع (للمبتدئين)

1. أنشئ مشروعًا في Google Cloud وفعّل **Google Chat API**.
   - انتقل إلى: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - فعّل واجهة برمجة التطبيقات إذا لم تكن مفعّلة بالفعل.
2. أنشئ **حساب خدمة**:
   - اضغط **Create Credentials** > **Service Account**.
   - سمّه بأي اسم تريده (مثلًا: `openclaw-chat`).
   - اترك الأذونات فارغة (اضغط **Continue**).
   - اترك الجهات ذات الوصول فارغة (اضغط **Done**).
3. أنشئ ونزّل **مفتاح JSON**:
   - في قائمة حسابات الخدمة، انقر على الحساب الذي أنشأته للتو.
   - انتقل إلى تبويب **Keys**.
   - انقر **Add Key** > **Create new key**.
   - اختر **JSON** واضغط **Create**.
4. خزّن ملف JSON الذي تم تنزيله على مضيف Gateway لديك (مثلًا: `~/.openclaw/googlechat-service-account.json`).
5. أنشئ تطبيق Google Chat في [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - املأ **Application info**:
     - **App name**: (مثلًا: `OpenClaw`)
     - **Avatar URL**: (مثلًا: `https://openclaw.ai/logo.png`)
     - **Description**: (مثلًا: `Personal AI Assistant`)
   - فعّل **Interactive features**.
   - ضمن **Functionality**، حدّد **Join spaces and group conversations**.
   - ضمن **Connection settings**، اختر **HTTP endpoint URL**.
   - ضمن **Triggers**، اختر **Use a common HTTP endpoint URL for all triggers** واضبطه على عنوان Gateway العام متبوعًا بـ `/googlechat`.
     - _تلميح: شغّل `openclaw status` للعثور على عنوان Gateway العام._
   - ضمن **Visibility**، حدّد **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - أدخل عنوان بريدك الإلكتروني (مثلًا: `user@example.com`) في مربع النص.
   - انقر **Save** في الأسفل.
6. **تفعيل حالة التطبيق**:
   - بعد الحفظ، **حدّث الصفحة**.
   - ابحث عن قسم **App status** (غالبًا قرب الأعلى أو الأسفل بعد الحفظ).
   - غيّر الحالة إلى **Live - available to users**.
   - انقر **Save** مرة أخرى.
7. هيّئ OpenClaw بمسار حساب الخدمة + جمهور الـ webhook:
   - متغير البيئة: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - أو التهيئة: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. اضبط نوع وقيمة جمهور الـ webhook (يطابق إعداد تطبيق Chat).
9. ابدأ تشغيل Gateway. سيقوم Google Chat بإرسال طلبات POST إلى مسار الـ webhook لديك.

## الإضافة إلى Google Chat

بمجرد تشغيل Gateway وإضافة بريدك الإلكتروني إلى قائمة الظهور:

1. انتقل إلى [Google Chat](https://chat.google.com/).
2. انقر أيقونة **+** (الزائد) بجوار **Direct Messages**.
3. في شريط البحث (حيث تضيف الأشخاص عادةً)، اكتب **اسم التطبيق** الذي هيّأته في Google Cloud Console.
   - **ملاحظة**: لن يظهر الروبوت في قائمة التصفّح «Marketplace» لأنه تطبيق خاص. يجب البحث عنه بالاسم.
4. اختر الروبوت من النتائج.
5. انقر **Add** أو **Chat** لبدء محادثة 1:1.
6. أرسل «Hello» لتشغيل المساعد!

## العنوان العام (Webhook فقط)

تتطلب Webhooks في Google Chat نقطة نهاية HTTPS عامة. لأسباب أمنية، **اعرض فقط مسار `/googlechat` على الإنترنت**. أبقِ لوحة تحكم OpenClaw ونقاط النهاية الحساسة الأخرى على شبكتك الخاصة.

### الخيار A: Tailscale Funnel (موصى به)

استخدم Tailscale Serve للوحة التحكم الخاصة وFunnel لمسار الـ webhook العام. هذا يُبقي `/` خاصًا مع تعريض `/googlechat` فقط.

1. **تحقق من العنوان الذي يرتبط به Gateway:**

   ```bash
   ss -tlnp | grep 18789
   ```

   دوّن عنوان IP (مثلًا: `127.0.0.1`، `0.0.0.0`، أو عنوان Tailscale مثل `100.x.x.x`).

2. **اعرض لوحة التحكم على tailnet فقط (المنفذ 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **اعرض مسار الـ webhook فقط للعامة:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **فوّض العُقدة للوصول عبر Funnel:**
   إذا طُلب منك، زر عنوان التفويض الظاهر في المخرجات لتمكين Funnel لهذه العُقدة ضمن سياسة tailnet.

5. **تحقق من التهيئة:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

سيكون عنوان الـ webhook العام لديك:
`https://<node-name>.<tailnet>.ts.net/googlechat`

وتبقى لوحة التحكم الخاصة ضمن tailnet فقط:
`https://<node-name>.<tailnet>.ts.net:8443/`

استخدم العنوان العام (بدون `:8443`) في تهيئة تطبيق Google Chat.

> ملاحظة: تستمر هذه التهيئة عبر إعادة التشغيل. لإزالتها لاحقًا، شغّل `tailscale funnel reset` و `tailscale serve reset`.

### الخيار B: وكيل عكسي (Caddy)

إذا كنت تستخدم وكيلًا عكسيًا مثل Caddy، فقم بتمرير المسار المحدد فقط:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

مع هذه التهيئة، سيتم تجاهل أي طلب إلى `your-domain.com/` أو إرجاع 404، بينما يتم توجيه `your-domain.com/googlechat` بأمان إلى OpenClaw.

### الخيار C: نفق Cloudflare

هيّئ قواعد الإدخال (ingress) للنفق لديك لتوجيه مسار الـ webhook فقط:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## كيف يعمل

1. يرسل Google Chat طلبات POST للـ webhook إلى Gateway. يتضمن كل طلب ترويسة `Authorization: Bearer <token>`.
2. يتحقق OpenClaw من الرمز المميّز مقابل `audienceType` + `audience` المُهيّأين:
   - `audienceType: "app-url"` → الجمهور هو عنوان HTTPS الخاص بالـ webhook.
   - `audienceType: "project-number"` → الجمهور هو رقم مشروع Cloud.
3. يتم توجيه الرسائل حسب المساحة:
   - تستخدم الرسائل المباشرة مفتاح الجلسة `agent:<agentId>:googlechat:dm:<spaceId>`.
   - تستخدم المساحات مفتاح الجلسة `agent:<agentId>:googlechat:group:<spaceId>`.
4. الوصول للرسائل المباشرة يكون بالاقتران افتراضيًا. يتلقى المُرسِلون غير المعروفين رمز اقتران؛ وافق باستخدام:
   - `openclaw pairing approve googlechat <code>`
5. تتطلب المساحات الجماعية ذكر @ افتراضيًا. استخدم `botUser` إذا احتاج اكتشاف الذِكر إلى اسم مستخدم التطبيق.

## الأهداف

استخدم هذه المعرّفات للتسليم وقوائم السماح:

- الرسائل المباشرة: `users/<userId>` أو `users/<email>` (تُقبل عناوين البريد الإلكتروني).
- المساحات: `spaces/<spaceId>`.

## أبرز نقاط التهيئة

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

ملاحظات:

- يمكن تمرير بيانات اعتماد حساب الخدمة أيضًا مضمنة باستخدام `serviceAccount` (سلسلة JSON).
- مسار الـ webhook الافتراضي هو `/googlechat` إذا لم يتم تعيين `webhookPath`.
- تتوفر التفاعلات عبر أداة `reactions` و `channels action` عند تمكين `actions.reactions`.
- يدعم `typingIndicator` كُلًا من `none` و `message` (الافتراضي) و `reaction` (يتطلب التفاعل OAuth للمستخدم).
- يتم تنزيل المرفقات عبر Chat API وتخزينها في خط أنابيب الوسائط (الحجم مُقيّد بواسطة `mediaMaxMb`).

## استكشاف الأخطاء وإصلاحها

### 405 Method Not Allowed

إذا أظهر Google Cloud Logs Explorer أخطاء مثل:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

فهذا يعني أن معالج الـ webhook غير مسجّل. الأسباب الشائعة:

1. **القناة غير مُهيّأة**: قسم `channels.googlechat` مفقود من تهيئتك. تحقّق باستخدام:

   ```bash
   openclaw config get channels.googlechat
   ```

   إذا أعاد «Config path not found»، فأضِف التهيئة (انظر [أبرز نقاط التهيئة](#config-highlights)).

2. **الإضافة غير مُمكّنة**: تحقّق من حالة الإضافة:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   إذا أظهرت «disabled»، فأضِف `plugins.entries.googlechat.enabled: true` إلى تهيئتك.

3. **لم تتم إعادة تشغيل Gateway**: بعد إضافة التهيئة، أعد تشغيل Gateway:

   ```bash
   openclaw gateway restart
   ```

تحقّق من أن القناة تعمل:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### مشكلات أخرى

- تحقّق من `openclaw channels status --probe` لأخطاء المصادقة أو نقص إعداد الجمهور.
- إذا لم تصل أي رسائل، أكّد عنوان الـ webhook + اشتراكات الأحداث في تطبيق Chat.
- إذا منعت بوابة الذِكر الردود، اضبط `botUser` على اسم مورد مستخدم التطبيق وتحقق من `requireMention`.
- استخدم `openclaw logs --follow` أثناء إرسال رسالة اختبار لمعرفة ما إذا كانت الطلبات تصل إلى Gateway.

مستندات ذات صلة:

- [تهيئة Gateway](/gateway/configuration)
- [الأمان](/gateway/security)
- [التفاعلات](/tools/reactions)
