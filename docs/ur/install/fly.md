---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Fly.io پر ڈپلائمنٹ

**ہدف:** OpenClaw Gateway کو [Fly.io](https://fly.io) مشین پر چلانا، مستقل اسٹوریج، خودکار HTTPS، اور Discord/چینل رسائی کے ساتھ۔

## آپ کو کیا درکار ہے

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) انسٹال شدہ
- Fly.io اکاؤنٹ (فری ٹائر بھی کام کرتا ہے)
- ماڈل تصدیق: Anthropic API کلید (یا دیگر فراہم کنندگان کی کلیدیں)
- چینل اسناد: Discord بوٹ ٹوکن، Telegram ٹوکن، وغیرہ

## مبتدیوں کے لیے فوری راستہ

1. ریپو کلون کریں → `fly.toml` کو حسبِ ضرورت بنائیں
2. ایپ + والیوم بنائیں → سیکریٹس سیٹ کریں
3. `fly deploy` کے ساتھ ڈپلائ کریں
4. کنفیگ بنانے کے لیے SSH کریں یا Control UI استعمال کریں

## 1) Fly ایپ بنائیں

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**ٹِپ:** اپنے قریب کا region منتخب کریں۔ عام اختیارات: `lhr` (London)، `iad` (Virginia)، `sjc` (San Jose)۔

## 2. fly.toml کنفیگر کریں

`fly.toml` میں ترمیم کریں تاکہ آپ کے ایپ نام اور ضروریات سے مطابقت ہو۔

**سیکیورٹی نوٹ:** ڈیفالٹ کنفیگ ایک پبلک URL کو ظاہر کرتا ہے۔ 48. بغیر عوامی IP کے ایک hardened ڈیپلائمنٹ کے لیے [Private Deployment](#private-deployment-hardened) دیکھیں یا `fly.private.toml` استعمال کریں۔

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

**اہم سیٹنگز:**

| سیٹنگ                          | وجہ                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | `0.0.0.0` سے بائنڈ کرتا ہے تاکہ Fly کا پراکسی گیٹ وے تک پہنچ سکے                                          |
| `--allow-unconfigured`         | کنفیگ فائل کے بغیر شروع کرتا ہے (بعد میں آپ ایک بنائیں گے)                             |
| `internal_port = 3000`         | Fly ہیلتھ چیکس کے لیے `--port 3000` (یا `OPENCLAW_GATEWAY_PORT`) سے مماثل ہونا لازم ہے |
| `memory = "2048mb"`            | 512MB بہت کم ہے؛ 2GB تجویز کردہ                                                                           |
| `OPENCLAW_STATE_DIR = "/data"` | والیوم پر اسٹیٹ کو برقرار رکھتا ہے                                                                        |

## 3. سیکریٹس سیٹ کریں

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

**نوٹس:**

- نان لوپ بیک بائنڈز (`--bind lan`) سکیورٹی کے لیے `OPENCLAW_GATEWAY_TOKEN` کا تقاضا کرتے ہیں۔
- ان ٹوکنز کو پاس ورڈز کی طرح محفوظ رکھیں۔
- 49. تمام API keys اور tokens کے لیے **config فائل کے بجائے env vars کو ترجیح دیں**۔ اس سے secrets کو `openclaw.json` سے باہر رکھا جاتا ہے جہاں وہ غلطی سے ظاہر یا لاگ ہو سکتے ہیں۔

## 4. ڈپلائ کریں

```bash
fly deploy
```

پہلی deploy پر Docker امیج بنتی ہے (~2-3 منٹ)۔ بعد کی deploys تیز ہوتی ہیں۔

ڈپلائمنٹ کے بعد، تصدیق کریں:

```bash
fly status
fly logs
```

آپ کو یہ نظر آنا چاہیے:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. کنفیگ فائل بنائیں

مناسب کنفیگ بنانے کے لیے مشین میں SSH کریں:

```bash
fly ssh console
```

کنفیگ ڈائریکٹری اور فائل بنائیں:

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

**نوٹ:** `OPENCLAW_STATE_DIR=/data` کے ساتھ، کنفیگ پاتھ `/data/openclaw.json` ہے۔

**نوٹ:** Discord ٹوکن درج ذیل میں سے کسی ایک سے آ سکتا ہے:

- ماحولیاتی متغیر: `DISCORD_BOT_TOKEN` (سیکریٹس کے لیے تجویز کردہ)
- کنفیگ فائل: `channels.discord.token`

اگر env var استعمال کر رہے ہیں تو کنفیگ میں ٹوکن شامل کرنے کی ضرورت نہیں۔ 50. گیٹ وے `DISCORD_BOT_TOKEN` کو خود بخود پڑھ لیتا ہے۔

لاگو کرنے کے لیے ری اسٹارٹ کریں:

```bash
exit
fly machine restart <machine-id>
```

## 6. Gateway تک رسائی

### Control UI

براؤزر میں کھولیں:

```bash
fly open
```

یا `https://my-openclaw.fly.dev/` پر جائیں

تصدیق کے لیے اپنا گیٹ وے ٹوکن (جو `OPENCLAW_GATEWAY_TOKEN` سے ہے) پیسٹ کریں۔

### لاگز

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH کنسول

```bash
fly ssh console
```

## خرابیوں کا ازالہ

### "App is not listening on expected address"

گیٹ وے `127.0.0.1` کے بجائے `0.0.0.0` پر بائنڈ ہو رہا ہے۔

**حل:** `fly.toml` میں اپنے پروسس کمانڈ میں `--bind lan` شامل کریں۔

### ہیلتھ چیکس فیل / کنکشن ریفیوزڈ

Fly کنفیگرڈ پورٹ پر گیٹ وے تک نہیں پہنچ پا رہا۔

**حل:** یقینی بنائیں کہ `internal_port` گیٹ وے پورٹ سے مماثل ہو ( `--port 3000` یا `OPENCLAW_GATEWAY_PORT=3000` سیٹ کریں)۔

### OOM / میموری مسائل

Container keeps restarting or getting killed. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.

**حل:** `fly.toml` میں میموری بڑھائیں:

```toml
[[vm]]
  memory = "2048mb"
```

یا موجودہ مشین اپڈیٹ کریں:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Note:** 512MB is too small. 1GB کام کر سکتا ہے لیکن لوڈ کے تحت یا verbose لاگنگ کے ساتھ OOM ہو سکتا ہے۔ **2GB تجویز کیا جاتا ہے۔**

### Gateway لاک مسائل

"already running" جیسی غلطیوں کے ساتھ گیٹ وے شروع ہونے سے انکار کرتا ہے۔

یہ اس وقت ہوتا ہے جب کنٹینر ری اسٹارٹ ہو مگر PID لاک فائل والیوم پر برقرار رہے۔

**حل:** لاک فائل حذف کریں:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

لاک فائل `/data/gateway.*.lock` پر ہے (کسی ذیلی ڈائریکٹری میں نہیں)۔

### کنفیگ پڑھا نہیں جا رہا

اگر `--allow-unconfigured` استعمال کریں تو گیٹ وے ایک minimal کنفیگ بناتا ہے۔ آپ کی کسٹم کنفیگ `/data/openclaw.json` ری اسٹارٹ پر پڑھی جانی چاہیے۔

تصدیق کریں کہ کنفیگ موجود ہے:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH کے ذریعے کنفیگ لکھنا

`fly ssh console -C` کمانڈ shell redirection کو سپورٹ نہیں کرتی۔ کنفیگ فائل لکھنے کے لیے:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Note:** `fly sftp` may fail if the file already exists. پہلے ڈیلیٹ کریں:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### اسٹیٹ برقرار نہیں رہ رہا

اگر ری اسٹارٹ کے بعد اسناد یا سیشن ضائع ہو جائیں تو اسٹیٹ ڈائریکٹری کنٹینر فائل سسٹم پر لکھ رہی ہے۔

**حل:** یقینی بنائیں کہ `fly.toml` میں `OPENCLAW_STATE_DIR=/data` سیٹ ہو اور دوبارہ ڈپلائ کریں۔

## اپڈیٹس

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### مشین کمانڈ اپڈیٹ کرنا

بغیر مکمل ری ڈپلائ کے اسٹارٹ اپ کمانڈ بدلنے کے لیے:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**نوٹ:** `fly deploy` کے بعد مشین کمانڈ `fly.toml` میں موجود ویلیوز پر ری سیٹ ہو سکتی ہے۔ اگر آپ نے دستی تبدیلیاں کی ہیں تو deploy کے بعد دوبارہ لاگو کریں۔

## نجی ڈپلائمنٹ (مضبوط)

ڈیفالٹ طور پر، Fly پبلک IPs الاٹ کرتا ہے، جس سے آپ کا گیٹ وے `https://your-app.fly.dev` پر قابلِ رسائی ہوتا ہے۔ یہ سہولت بخش ہے لیکن اس کا مطلب ہے کہ آپ کی تعیناتی انٹرنیٹ اسکینرز (Shodan، Censys وغیرہ) کے لیے قابلِ دریافت ہے۔

**بغیر عوامی نمائش** کے مضبوط ڈپلائمنٹ کے لیے نجی ٹیمپلیٹ استعمال کریں۔

### نجی ڈپلائمنٹ کب استعمال کریں

- آپ صرف **آؤٹ باؤنڈ** کالز/پیغامات کرتے ہیں (ان باؤنڈ ویب ہوکس نہیں)
- کسی بھی ویب ہوک کال بیکس کے لیے **ngrok یا Tailscale** سرنگیں استعمال کرتے ہیں
- براؤزر کے بجائے **SSH، پراکسی، یا WireGuard** کے ذریعے گیٹ وے تک رسائی چاہتے ہیں
- ڈپلائمنٹ کو **انٹرنیٹ اسکینرز سے مخفی** رکھنا چاہتے ہیں

### سیٹ اپ

معیاری کنفیگ کے بجائے `fly.private.toml` استعمال کریں:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

یا موجودہ ڈپلائمنٹ تبدیل کریں:

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

اس کے بعد، `fly ips list` میں صرف `private` قسم کا IP دکھنا چاہیے:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### نجی ڈپلائمنٹ تک رسائی

چونکہ کوئی عوامی URL نہیں، ان میں سے ایک طریقہ استعمال کریں:

**آپشن 1: لوکل پراکسی (سب سے آسان)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**آپشن 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**آپشن 3: صرف SSH**

```bash
fly ssh console -a my-openclaw
```

### نجی ڈپلائمنٹ کے ساتھ ویب ہوکس

اگر آپ کو webhook callbacks درکار ہیں (Twilio، Telnyx وغیرہ) بغیر پبلک ایکسپوژر کے:

1. **ngrok سرنگ** — ngrok کو کنٹینر کے اندر یا سائیڈ کار کے طور پر چلائیں
2. **Tailscale Funnel** — Tailscale کے ذریعے مخصوص راستے ایکسپوز کریں
3. **صرف آؤٹ باؤنڈ** — کچھ فراہم کنندگان (Twilio) ویب ہوکس کے بغیر آؤٹ باؤنڈ کالز کے لیے ٹھیک کام کرتے ہیں

ngrok کے ساتھ مثال وائس کال کنفیگ:

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

ngrok ٹنل کنٹینر کے اندر چلتی ہے اور Fly ایپ کو ظاہر کیے بغیر ایک پبلک webhook URL فراہم کرتی ہے۔ forwarded host headers کو قبول کرنے کے لیے `webhookSecurity.allowedHosts` کو پبلک ٹنل hostname پر سیٹ کریں۔

### سکیورٹی فوائد

| پہلو             | عوامی        | نجی           |
| ---------------- | ------------ | ------------- |
| انٹرنیٹ اسکینرز  | قابلِ دریافت | مخفی          |
| براہِ راست حملے  | ممکن         | مسدود         |
| Control UI رسائی | براؤزر       | پراکسی/VPN    |
| ویب ہوک ترسیل    | براہِ راست   | سرنگ کے ذریعے |

## نوٹس

- Fly.io **x86 آرکیٹیکچر** استعمال کرتا ہے (ARM نہیں)
- Dockerfile دونوں آرکیٹیکچرز کے ساتھ مطابقت رکھتا ہے
- WhatsApp/Telegram آن بورڈنگ کے لیے `fly ssh console` استعمال کریں
- مستقل ڈیٹا والیوم پر `/data` میں موجود ہوتا ہے
- Signal کے لیے Java + signal-cli درکار ہے؛ کسٹم امیج استعمال کریں اور میموری 2GB+ رکھیں۔

## لاگت

تجویز کردہ کنفیگ (`shared-cpu-2x`، 2GB RAM) کے ساتھ:

- استعمال کے مطابق تقریباً $10–15/ماہ
- فری ٹائر میں کچھ الاونس شامل ہے

تفصیلات کے لیے [Fly.io قیمتیں](https://fly.io/docs/about/pricing/) دیکھیں۔
