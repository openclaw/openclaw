---
summary: "دفع Gmail عبر Pub/Sub موصول بـ Webhooks الخاصة بـ OpenClaw باستخدام gogcli"
read_when:
  - توصيل مُحفِّزات صندوق وارد Gmail بـ OpenClaw
  - إعداد دفع Pub/Sub لإيقاظ الوكيل
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

الهدف: مراقبة Gmail -> دفع Pub/Sub -> `gog gmail watch serve` -> Webhook لـ OpenClaw.

## المسبق

- تثبيت `gcloud` وتسجيل الدخول ([دليل التثبيت](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- تثبيت `gog` (gogcli) وتفويضه لحساب Gmail ([gogcli.sh](https://gogcli.sh/)).
- تفعيل Webhooks في OpenClaw (راجع [Webhooks](/automation/webhook)).
- تسجيل الدخول إلى `tailscale` ([tailscale.com](https://tailscale.com/)). يعتمد الإعداد المدعوم على Tailscale Funnel كنقطة HTTPS عامة.
  يمكن أن تعمل خدمات أنفاق أخرى، لكنها يدوية/غير مدعومة وتتطلب توصيلاً يدويًا.
  حاليًا، Tailscale هو الخيار المدعوم لدينا.

مثال على تهيئة الـ hook (تمكين تعيين الإعداد المسبق لـ Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

لتسليم ملخص Gmail إلى واجهة محادثة، تجاوز الإعداد المسبق بتعيين
`deliver` + `channel`/`to` (اختياري):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

إذا كنت تريد قناة ثابتة، عيّن `channel` + `to`. وإلا فإن `channel: "last"`
يستخدم مسار التسليم الأخير (ويعود افتراضيًا إلى WhatsApp).

لفرض نموذج أقل تكلفة لتشغيلات Gmail، عيّن `model` في التعيين
(`provider/model` أو الاسم المستعار). إذا فرضت `agents.defaults.models`، فضمّنه هناك.

لتعيين نموذج افتراضي ومستوى التفكير خصيصًا لـ hooks الخاصة بـ Gmail، أضِف
`hooks.gmail.model` / `hooks.gmail.thinking` في التهيئة لديك:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

ملاحظات:

- لا يزال `model`/`thinking` لكل hook في التعيين يتجاوز هذه القيم الافتراضية.
- ترتيب الرجوع: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → الأساسي (المصادقة/تحديد المعدل/المهلات).
- إذا تم تعيين `agents.defaults.models`، فيجب أن يكون نموذج Gmail ضمن قائمة السماح.
- يتم تغليف محتوى hook الخاص بـ Gmail افتراضيًا بحدود أمان للمحتوى الخارجي.
  لتعطيل ذلك (خطير)، عيّن `hooks.gmail.allowUnsafeExternalContent: true`.

لتخصيص معالجة الحمولة بشكل أعمق، أضِف `hooks.mappings` أو وحدة تحويل JS/TS
ضمن `hooks.transformsDir` (راجع [Webhooks](/automation/webhook)).

## المعالج (موصى به)

استخدم مساعد OpenClaw لربط كل شيء معًا (يثبّت الاعتمادات على macOS عبر brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

الإعدادات الافتراضية:

- يستخدم Tailscale Funnel كنقطة دفع عامة.
- يكتب تهيئة `hooks.gmail` لـ `openclaw webhooks gmail run`.
- يفعّل الإعداد المسبق لـ hook الخاص بـ Gmail (`hooks.presets: ["gmail"]`).

ملاحظة المسار: عند تمكين `tailscale.mode`، يقوم OpenClaw تلقائيًا بتعيين
`hooks.gmail.serve.path` إلى `/` ويُبقي المسار العام عند
`hooks.gmail.tailscale.path` (الافتراضي `/gmail-pubsub`) لأن Tailscale
يزيل بادئة set-path قبل الوكالة.
إذا كنت بحاجة إلى أن يستقبل الخلفية المسار المُسبق، فعيّن
`hooks.gmail.tailscale.target` (أو `--tailscale-target`) إلى عنوان URL كامل مثل
`http://127.0.0.1:8788/gmail-pubsub` وطابق `hooks.gmail.serve.path`.

هل تريد نقطة نهاية مخصصة؟ هل تريد نقطة نهاية مخصّصة؟ استخدم `--push-endpoint <url>` أو `--tailscale off`.

ملاحظة المنصّة: على macOS يقوم المعالج بتثبيت `gcloud` و`gogcli` و`tailscale`
عبر Homebrew؛ وعلى Linux قم بتثبيتها يدويًا أولًا.

التشغيل التلقائي لـ Gateway (موصى به):

- عند تعيين `hooks.enabled=true` و`hooks.gmail.account`، يبدأ Gateway
  `gog gmail watch serve` عند الإقلاع ويجدد المراقبة تلقائيًا.
- عيّن `OPENCLAW_SKIP_GMAIL_WATCHER=1` لإلغاء الاشتراك (مفيد إذا كنت تشغّل الخدمة بنفسك).
- لا تشغّل الخدمة اليدوية في الوقت نفسه، وإلا ستواجه
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

الخدمة اليدوية (تشغّل `gog gmail watch serve` + تجديد تلقائي):

```bash
openclaw webhooks gmail run
```

## إعداد لمرة واحدة

1. اختر مشروع GCP **الذي يملك عميل OAuth** المستخدم بواسطة `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

ملاحظة: تتطلب مراقبة Gmail أن يكون موضوع Pub/Sub في نفس المشروع الخاص بعميل OAuth.

2. تمكين APIs:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. إنشاء موضوع:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. السماح لدفع Gmail بالنشر:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## بدء المراقبة

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

احفظ `history_id` من المخرجات (لأغراض التصحيح).

## تشغيل معالج الدفع

مثال محلي (مصادقة برمز مشترك):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

ملاحظات:

- يحمي `--token` نقطة نهاية الدفع (`x-gog-token` أو `?token=`).
- يشير `--hook-url` إلى `/hooks/gmail` في OpenClaw (مُعيَّن؛ تشغيل معزول + ملخص إلى الرئيسي).
- يتحكّم `--include-body` و`--max-bytes` في مقتطف النص المُرسل إلى OpenClaw.

موصى به: يغلّف `openclaw webhooks gmail run` التدفق نفسه ويجدد المراقبة تلقائيًا.

## كشف المعالج (متقدم، غير مدعوم)

إذا كنت بحاجة إلى نفق غير Tailscale، فقم بتوصيله يدويًا واستخدم عنوان URL العام في اشتراك الدفع
(غير مدعوم، دون ضوابط حماية):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

استخدم عنوان URL المُنشأ كنقطة نهاية الدفع:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

للإنتاج: استخدم نقطة HTTPS مستقرة واضبط Pub/Sub OIDC JWT، ثم شغّل:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## الاختبار

أرسل رسالة إلى صندوق الوارد المُراقَب:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

تحقق من حالة المراقبة والسجل:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## استكشاف الأخطاء وإصلاحها

- `Invalid topicName`: عدم تطابق المشروع (الموضوع ليس في مشروع عميل OAuth).
- `User not authorized`: فقدان `roles/pubsub.publisher` على الموضوع.
- رسائل فارغة: يوفر دفع Gmail فقط `historyId`؛ اجلب البيانات عبر `gog gmail history`.

## التنظيف

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
