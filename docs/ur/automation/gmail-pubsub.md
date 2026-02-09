---
summary: "gogcli کے ذریعے OpenClaw ویب ہُکس میں مربوط Gmail Pub/Sub پُش"
read_when:
  - OpenClaw کے ساتھ Gmail اِن باکس ٹرگرز کو جوڑنا
  - ایجنٹ ویک کے لیے Pub/Sub پُش سیٹ اپ کرنا
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

ہدف: Gmail واچ -> Pub/Sub پُش -> `gog gmail watch serve` -> OpenClaw ویب ہُک۔

## پیشگی تقاضے

- `gcloud` انسٹال اور لاگ اِن ہو ([انسٹال گائیڈ](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) انسٹال ہو اور Gmail اکاؤنٹ کے لیے مجاز ہو ([gogcli.sh](https://gogcli.sh/)).
- OpenClaw ہُکس فعال ہوں (دیکھیں [Webhooks](/automation/webhook)).
- `tailscale` لاگ اِن ہے ([tailscale.com](https://tailscale.com/))۔ سپورٹڈ سیٹ اپ عوامی HTTPS اینڈ پوائنٹ کے لیے Tailscale Funnel استعمال کرتا ہے۔
  دیگر ٹنل سروسز کام کر سکتی ہیں، لیکن وہ DIY/غیر سپورٹڈ ہیں اور دستی وائرنگ کی ضرورت ہوتی ہے۔
  اس وقت، ہم Tailscale کو ہی سپورٹ کرتے ہیں۔

مثالی ہُک کنفیگ (Gmail پری سیٹ میپنگ فعال کریں):

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

Gmail خلاصہ کو کسی چیٹ سرفیس پر پہنچانے کے لیے، پری سیٹ کو ایسی میپنگ سے اووررائیڈ کریں
جو `deliver` + اختیاری `channel`/`to` سیٹ کرے:

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

اگر آپ ایک فکسڈ چینل چاہتے ہیں تو `channel` + `to` سیٹ کریں۔ ورنہ `channel: "last"` آخری ڈیلیوری روٹ استعمال کرتا ہے (واٹس ایپ پر فال بیک ہوتا ہے)۔

Gmail رنز کے لیے سستا ماڈل مجبور کرنے کو میپنگ میں `model` سیٹ کریں (`provider/model` یا عرف)۔ اگر آپ `agents.defaults.models` نافذ کرتے ہیں تو اسے وہاں شامل کریں۔

خاص طور پر Gmail ہُکس کے لیے ڈیفالٹ ماڈل اور تھنکنگ لیول سیٹ کرنے کے لیے،
اپنی کنفیگ میں `hooks.gmail.model` / `hooks.gmail.thinking` شامل کریں:

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

نوٹس:

- میپنگ میں فی ہُک `model`/`thinking` پھر بھی ان ڈیفالٹس کو اووررائیڈ کرتا ہے۔
- فالبیک ترتیب: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → پرائمری (auth/rate-limit/timeouts)۔
- اگر `agents.defaults.models` سیٹ ہو تو Gmail ماڈل اجازت فہرست میں ہونا چاہیے۔
- Gmail ہُک مواد بطورِ ڈیفالٹ بیرونی مواد کی حفاظت کی حدود کے ساتھ لپٹا ہوتا ہے۔
  غیر فعال کرنے کے لیے (خطرناک)، `hooks.gmail.allowUnsafeExternalContent: true` سیٹ کریں۔

پے لوڈ ہینڈلنگ کو مزید حسبِ ضرورت بنانے کے لیے، `hooks.mappings` شامل کریں یا JS/TS ٹرانسفارم ماڈیول
`hooks.transformsDir` کے تحت رکھیں (دیکھیں [Webhooks](/automation/webhook))۔

## وزارڈ (سفارش کردہ)

سب کچھ ایک ساتھ وائر کرنے کے لیے OpenClaw ہیلپر استعمال کریں (macOS پر brew کے ذریعے ڈیپس انسٹال کرتا ہے):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

ڈیفالٹس:

- عوامی پُش اینڈپوائنٹ کے لیے Tailscale Funnel استعمال کرتا ہے۔
- `openclaw webhooks gmail run` کے لیے `hooks.gmail` کنفیگ لکھتا ہے۔
- Gmail ہُک پری سیٹ (`hooks.presets: ["gmail"]`) فعال کرتا ہے۔

پاتھ نوٹ: جب `tailscale.mode` فعال ہو تو OpenClaw خودکار طور پر `hooks.gmail.serve.path` کو `/` پر سیٹ کرتا ہے اور عوامی پاتھ کو `hooks.gmail.tailscale.path` (بطورِ ڈیفالٹ `/gmail-pubsub`) پر رکھتا ہے کیونکہ Tailscale پروکسی کرنے سے پہلے set-path پری فکس کو ہٹا دیتا ہے۔
اگر آپ کو بیک اینڈ کو پری فکسڈ پاتھ وصول کرنے کی ضرورت ہو تو `hooks.gmail.tailscale.target` (یا `--tailscale-target`) کو مکمل URL جیسے `http://127.0.0.1:8788/gmail-pubsub` پر سیٹ کریں اور `hooks.gmail.serve.path` کو میچ کریں۔

1. کیا آپ کو ایک حسبِ ضرورت endpoint چاہیے؟ 2. `--push-endpoint <url>` یا `--tailscale off` استعمال کریں۔

پلیٹ فارم نوٹ: macOS پر وزارڈ `gcloud`، `gogcli`، اور `tailscale`
Homebrew کے ذریعے انسٹال کرتا ہے؛ Linux پر پہلے انہیں دستی طور پر انسٹال کریں۔

Gateway خودکار آغاز (سفارش کردہ):

- جب `hooks.enabled=true` اور `hooks.gmail.account` سیٹ ہوں، Gateway
  بوٹ پر `gog gmail watch serve` شروع کرتا ہے اور واچ خودکار طور پر تجدید کرتا ہے۔
- آپٹ آؤٹ کے لیے `OPENCLAW_SKIP_GMAIL_WATCHER=1` سیٹ کریں (اگر آپ ڈیمن خود چلاتے ہیں تو مفید)۔
- دستی ڈیمن ایک ہی وقت میں نہ چلائیں، ورنہ
  `listen tcp 127.0.0.1:8788: bind: address already in use` کا سامنا ہوگا۔

دستی ڈیمن (شروع کرتا ہے `gog gmail watch serve` + خودکار تجدید):

```bash
openclaw webhooks gmail run
```

## ایک بار کا سیٹ اپ

1. وہ GCP پروجیکٹ منتخب کریں **جو OAuth کلائنٹ کا مالک ہو** جسے `gog` استعمال کرتا ہے۔

```bash
gcloud auth login
gcloud config set project <project-id>
```

نوٹ: Gmail واچ کے لیے ضروری ہے کہ Pub/Sub ٹاپک اسی پروجیکٹ میں ہو جس میں OAuth کلائنٹ موجود ہو۔

2. APIs فعال کریں:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. ایک ٹاپک بنائیں:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Gmail پُش کو پبلش کرنے کی اجازت دیں:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## واچ شروع کریں

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

آؤٹ پٹ سے `history_id` محفوظ کریں (ڈی بگنگ کے لیے)۔

## پُش ہینڈلر چلائیں

لوکل مثال (مشترکہ ٹوکن تصدیق):

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

نوٹس:

- `--token` پُش اینڈپوائنٹ کو محفوظ کرتا ہے (`x-gog-token` یا `?token=`)۔
- `--hook-url` OpenClaw `/hooks/gmail` کی طرف اشارہ کرتا ہے (میپڈ؛ علیحدہ رن + خلاصہ مین کو)۔
- `--include-body` اور `--max-bytes` OpenClaw کو بھیجے جانے والے باڈی اسنیپٹ کو کنٹرول کرتے ہیں۔

سفارش کردہ: `openclaw webhooks gmail run` اسی فلو کو لپیٹتا ہے اور واچ خودکار طور پر تجدید کرتا ہے۔

## ہینڈلر کو ایکسپوز کریں (اعلیٰ درجے کا، غیر معاون)

اگر آپ کو non-Tailscale ٹنل درکار ہو تو اسے دستی طور پر وائر کریں اور پُش
سبسکرپشن میں عوامی URL استعمال کریں (غیر معاون، کوئی گارڈ ریلز نہیں):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

تیار شدہ URL کو پُش اینڈپوائنٹ کے طور پر استعمال کریں:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

پروڈکشن: ایک مستحکم HTTPS اینڈپوائنٹ استعمال کریں اور Pub/Sub OIDC JWT کنفیگر کریں، پھر چلائیں:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## ٹیسٹ

نگرانی شدہ اِن باکس پر ایک پیغام بھیجیں:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

واچ اسٹیٹ اور ہسٹری چیک کریں:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## خرابیوں کا ازالہ

- `Invalid topicName`: پروجیکٹ عدم مطابقت (ٹاپک OAuth کلائنٹ پروجیکٹ میں نہیں)۔
- `User not authorized`: ٹاپک پر `roles/pubsub.publisher` موجود نہیں۔
- خالی پیغامات: Gmail پُش صرف `historyId` فراہم کرتا ہے؛ `gog gmail history` کے ذریعے فِچ کریں۔

## صفائی

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
