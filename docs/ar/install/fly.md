---
title: Fly.io
description: نشر OpenClaw على Fly.io
---

# نشر Fly.io

**الهدف:** تشغيل OpenClaw Gateway على جهاز [Fly.io](https://fly.io) مع تخزين دائم، وHTTPS تلقائي، وإتاحة الوصول عبر Discord/القنوات.

## ما الذي تحتاجه

- تثبيت [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- حساب Fly.io (الطبقة المجانية تعمل)
- تفويض النموذج: مفتاح Anthropic API (أو مفاتيح موفّرين آخرين)
- بيانات اعتماد القنوات: رمز بوت Discord، رمز Telegram، إلخ.

## المسار السريع للمبتدئين

1. استنساخ المستودع → تخصيص `fly.toml`
2. إنشاء التطبيق + وحدة التخزين → تعيين الأسرار
3. النشر باستخدام `fly deploy`
4. الدخول عبر SSH لإنشاء التهيئة أو استخدام واجهة التحكم

## 1) إنشاء تطبيق Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**نصيحة:** اختر منطقة قريبة منك. خيارات شائعة: `lhr` (لندن)، `iad` (فيرجينيا)، `sjc` (سان خوسيه).

## 2. تهيئة fly.toml

حرّر `fly.toml` ليتطابق مع اسم تطبيقك ومتطلباتك.

**ملاحظة أمنية:** التهيئة الافتراضية تكشف عنوان URL عامًا. لنشر مُحصّن بدون عنوان IP عام، راجع [النشر الخاص](#private-deployment-hardened) أو استخدم `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**الإعدادات الأساسية:**

| الإعداد                        | السبب                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `--bind lan`                   | الربط مع `0.0.0.0` لكي يتمكن وكيل Fly من الوصول إلى Gateway                                     |
| `--allow-unconfigured`         | البدء بدون ملف تهيئة (ستنشئ واحدًا لاحقًا)                                   |
| `internal_port = 3000`         | يجب أن يطابق `--port 3000` (أو `OPENCLAW_GATEWAY_PORT`) لفحوصات الصحة في Fly |
| `memory = "2048mb"`            | 512MB صغيرة جدًا؛ يُوصى بـ 2GB                                                                  |
| `OPENCLAW_STATE_DIR = "/data"` | استمرار الحالة على مستوى الصوت                                                                  |

## 3. تعيين الأسرار

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**ملاحظات:**

- الارتباطات غير المحلية (`--bind lan`) تتطلب `OPENCLAW_GATEWAY_TOKEN` لأسباب أمنية.
- تعامل مع هذه الرموز ككلمات مرور.
- **فضّل متغيرات البيئة على ملف التهيئة** لجميع مفاتيح API والرموز. هذا يُبقي الأسرار خارج `openclaw.json` حيث قد تُكشف أو تُسجَّل عن غير قصد.

## 4. النشر

```bash
fly deploy
```

أول عملية نشر تبني صورة Docker (~2–3 دقائق). عمليات النشر اللاحقة أسرع.

بعد النشر، تحقق:

```bash
fly status
fly logs
```

يجب أن ترى:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. إنشاء ملف التهيئة

ادخل عبر SSH إلى الجهاز لإنشاء تهيئة مناسبة:

```bash
fly ssh console
```

أنشئ دليل التهيئة والملف:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**ملاحظة:** مع `OPENCLAW_STATE_DIR=/data`، يكون مسار التهيئة هو `/data/openclaw.json`.

**ملاحظة:** يمكن توفير رمز Discord من أحد الخيارين:

- متغير بيئة: `DISCORD_BOT_TOKEN` (مُوصى به للأسرار)
- ملف التهيئة: `channels.discord.token`

إذا استخدمت متغير البيئة، فلا حاجة لإضافة الرمز إلى التهيئة. يقرأ Gateway `DISCORD_BOT_TOKEN` تلقائيًا.

أعد التشغيل للتطبيق:

```bash
exit
fly machine restart <machine-id>
```

## 6. الوصول إلى Gateway

### واجهة التحكم

افتح في المتصفح:

```bash
fly open
```

أو زُر `https://my-openclaw.fly.dev/`

الصق رمز Gateway الخاص بك (الذي من `OPENCLAW_GATEWAY_TOKEN`) للمصادقة.

### السجلات

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### وحدة تحكم SSH

```bash
fly ssh console
```

## استكشاف الأخطاء وإصلاحها

### «التطبيق لا يستمع على العنوان المتوقع»

Gateway يرتبط بـ `127.0.0.1` بدلًا من `0.0.0.0`.

**الحل:** أضف `--bind lan` إلى أمر العملية في `fly.toml`.

### فشل فحوصات الصحة / رفض الاتصال

لا يستطيع Fly الوصول إلى Gateway على المنفذ المُهيّأ.

**الحل:** تأكّد من أن `internal_port` يطابق منفذ Gateway (عيّن `--port 3000` أو `OPENCLAW_GATEWAY_PORT=3000`).

### مشاكل OOM / الذاكرة

تستمر الحاوية في إعادة التشغيل أو يتم إيقافها. دلائل: `SIGABRT`، `v8::internal::Runtime_AllocateInYoungGeneration`، أو إعادة تشغيل صامتة.

**الحل:** زِد الذاكرة في `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

أو حدّث جهازًا موجودًا:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**ملاحظة:** 512MB صغيرة جدًا. قد تعمل 1GB لكنها قد تتعرّض لـ OOM تحت الحمل أو مع تسجيل مُفصّل. **يُوصى بـ 2GB.**

### مشاكل قفل Gateway

يرفض Gateway البدء مع أخطاء «قيد التشغيل بالفعل».

يحدث هذا عندما تُعاد تشغيل الحاوية بينما يبقى ملف قفل PID على وحدة التخزين.

**الحل:** احذف ملف القفل:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

يوجد ملف القفل في `/data/gateway.*.lock` (ليس داخل دليل فرعي).

### عدم قراءة التهيئة

إذا كنت تستخدم `--allow-unconfigured`، ينشئ Gateway تهيئة دنيا. يجب قراءة تهيئتك المخصّصة في `/data/openclaw.json` عند إعادة التشغيل.

تحقّق من وجود التهيئة:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### كتابة التهيئة عبر SSH

أمر `fly ssh console -C` لا يدعم إعادة توجيه الصدفة. لكتابة ملف تهيئة:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**ملاحظة:** قد يفشل `fly sftp` إذا كان الملف موجودًا بالفعل. احذفه أولًا:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### عدم استمرار الحالة

إذا فقدت بيانات الاعتماد أو الجلسات بعد إعادة التشغيل، فهذا يعني أن دليل الحالة يكتب إلى نظام ملفات الحاوية.

**الحل:** تأكّد من تعيين `OPENCLAW_STATE_DIR=/data` في `fly.toml` ثم أعد النشر.

## التحديثات

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### تحديث أمر الجهاز

إذا احتجت إلى تغيير أمر البدء دون إعادة نشر كاملة:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**ملاحظة:** بعد `fly deploy`، قد يُعاد تعيين أمر الجهاز إلى ما هو موجود في `fly.toml`. إذا أجريت تغييرات يدوية، فأعد تطبيقها بعد النشر.

## النشر الخاص (مرتفع)

افتراضيًا، يخصّص Fly عناوين IP عامة، مما يجعل Gateway متاحًا على `https://your-app.fly.dev`. هذا مريح لكنه يعني أن نشرك قابل للاكتشاف بواسطة ماسحات الإنترنت (Shodan، Censys، إلخ).

لنشر مُحصّن **دون تعرّض عام**، استخدم القالب الخاص.

### متى تستخدم النشر الخاص

- تُجري مكالمات/رسائل **صادرة فقط** (لا توجد webhooks واردة)
- تستخدم أنفاق **ngrok أو Tailscale** لأي ردود webhook
- تصل إلى Gateway عبر **SSH أو proxy أو WireGuard** بدل المتصفح
- تريد نشرًا **مخفيًا عن ماسحات الإنترنت**

### الإعداد

استخدم `fly.private.toml` بدل التهيئة القياسية:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

أو حوّل نشرًا قائمًا:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

بعد ذلك، يجب أن يُظهر `fly ips list` فقط عنوان IP من النوع `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### الوصول إلى نشر خاص

نظرًا لعدم وجود عنوان URL عام، استخدم إحدى الطرق التالية:

**الخيار 1: proxy محلي (الأبسط)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**الخيار 2: VPN عبر WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**الخيار 3: SSH فقط**

```bash
fly ssh console -a my-openclaw
```

### Webhooks مع النشر الخاص

إذا احتجت إلى ردود webhook (Twilio، Telnyx، إلخ) دون تعرّض عام: دون التعرض العلني:

1. **نفق ngrok** — شغّل ngrok داخل الحاوية أو كحاوية جانبية
2. **Tailscale Funnel** — اكشف مسارات محددة عبر Tailscale
3. **صادر فقط** — يعمل بعض المزوّدين (Twilio) جيدًا للمكالمات الصادرة دون webhooks

مثال تهيئة مكالمة صوتية مع ngrok:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

يعمل نفق ngrok داخل الحاوية ويوفّر عنوان URL عامًا للـ webhook دون تعريض تطبيق Fly نفسه. عيّن `webhookSecurity.allowedHosts` إلى اسم مضيف النفق العام ليتم قبول رؤوس المضيف المُعاد توجيهها.

### فوائد أمنية

| الجانب               | عامة          | خاص       |
| -------------------- | ------------- | --------- |
| ماسحات الإنترنت      | قابل للاكتشاف | مخفي      |
| الهجمات المباشرة     | ممكنة         | محظور     |
| الوصول لواجهة التحكم | متصفح         | Proxy/VPN |
| تسليم Webhook        | مباشر         | عبر نفق   |

## ملاحظات

- يستخدم Fly.io **معمارية x86** (وليس ARM)
- ملف Dockerfile متوافق مع المعماريتين
- لتهيئة WhatsApp/Telegram، استخدم `fly ssh console`
- توجد البيانات الدائمة على وحدة التخزين في `/data`
- يتطلب Signal Java + signal-cli؛ استخدم صورة مخصّصة واحتفظ بالذاكرة عند 2GB+.

## التكلفة

مع التهيئة المُوصى بها (`shared-cpu-2x`، ذاكرة 2GB):

- حوالي 10–15 دولارًا شهريًا حسب الاستخدام
- تتضمن الطبقة المجانية بعض المخصصات

راجع [تسعير Fly.io](https://fly.io/docs/about/pricing/) للتفاصيل.
