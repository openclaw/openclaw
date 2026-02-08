---
title: Fly.io
description: Deploy OpenClaw on Fly.io
x-i18n:
  source_path: install/fly.md
  source_hash: 148f8e3579f185f1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:38Z
---

# Fly.io पर परिनियोजन

**लक्ष्य:** स्थायी स्टोरेज, स्वचालित HTTPS, और Discord/चैनल एक्सेस के साथ [Fly.io](https://fly.io) मशीन पर चल रहा OpenClaw Gateway।

## आपको क्या चाहिए

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) स्थापित
- Fly.io खाता (फ्री टियर काम करता है)
- मॉडल प्रमाणीकरण: Anthropic API key (या अन्य प्रदाता कुंजियाँ)
- चैनल क्रेडेंशियल्स: Discord बॉट टोकन, Telegram टोकन, आदि

## शुरुआती त्वरित मार्ग

1. रिपॉज़िटरी क्लोन करें → `fly.toml` को अनुकूलित करें
2. ऐप + वॉल्यूम बनाएँ → सीक्रेट्स सेट करें
3. `fly deploy` के साथ डिप्लॉय करें
4. कॉन्फ़िग बनाने के लिए SSH करें या Control UI का उपयोग करें

## 1) Fly ऐप बनाएँ

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**सुझाव:** अपने पास का क्षेत्र चुनें। सामान्य विकल्प: `lhr` (लंदन), `iad` (वर्जीनिया), `sjc` (सैन जोस)।

## 2) fly.toml कॉन्फ़िगर करें

अपने ऐप नाम और आवश्यकताओं से मेल खाने के लिए `fly.toml` संपादित करें।

**सुरक्षा टिप्पणी:** डिफ़ॉल्ट कॉन्फ़िग एक सार्वजनिक URL उजागर करता है। बिना सार्वजनिक IP के सुदृढ़ परिनियोजन के लिए [Private Deployment](#private-deployment-hardened) देखें या `fly.private.toml` का उपयोग करें।

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

**मुख्य सेटिंग्स:**

| सेटिंग                         | कारण                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `--bind lan`                   | `0.0.0.0` से बाइंड करता है ताकि Fly का प्रॉक्सी Gateway तक पहुँच सके                |
| `--allow-unconfigured`         | बिना कॉन्फ़िग फ़ाइल के शुरू करता है (आप बाद में एक बनाएँगे)                         |
| `internal_port = 3000`         | Fly हेल्थ चेक्स के लिए `--port 3000` (या `OPENCLAW_GATEWAY_PORT`) से मेल खाना चाहिए |
| `memory = "2048mb"`            | 512MB बहुत कम है; 2GB अनुशंसित                                                      |
| `OPENCLAW_STATE_DIR = "/data"` | वॉल्यूम पर स्टेट को स्थायी बनाता है                                                 |

## 3) सीक्रेट्स सेट करें

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

**नोट्स:**

- नॉन-लूपबैक बाइंड्स (`--bind lan`) के लिए सुरक्षा हेतु `OPENCLAW_GATEWAY_TOKEN` आवश्यक है।
- इन टोकनों को पासवर्ड की तरह संभालें।
- **सभी API keys और टोकनों के लिए कॉन्फ़िग फ़ाइल के बजाय env vars को प्राथमिकता दें।** इससे सीक्रेट्स `openclaw.json` से बाहर रहते हैं जहाँ वे गलती से उजागर या लॉग हो सकते हैं।

## 4) डिप्लॉय

```bash
fly deploy
```

पहला डिप्लॉय Docker इमेज बनाता है (~2–3 मिनट)। बाद के डिप्लॉय तेज़ होते हैं।

डिप्लॉयमेंट के बाद, सत्यापित करें:

```bash
fly status
fly logs
```

आपको यह दिखना चाहिए:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) कॉन्फ़िग फ़ाइल बनाएँ

उचित कॉन्फ़िग बनाने के लिए मशीन में SSH करें:

```bash
fly ssh console
```

कॉन्फ़िग डायरेक्टरी और फ़ाइल बनाएँ:

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

**टिप्पणी:** `OPENCLAW_STATE_DIR=/data` के साथ, कॉन्फ़िग पथ `/data/openclaw.json` है।

**टिप्पणी:** Discord टोकन इनमें से किसी एक से आ सकता है:

- पर्यावरण चर: `DISCORD_BOT_TOKEN` (सीक्रेट्स के लिए अनुशंसित)
- कॉन्फ़िग फ़ाइल: `channels.discord.token`

यदि env var का उपयोग कर रहे हैं, तो कॉन्फ़िग में टोकन जोड़ने की आवश्यकता नहीं है। Gateway `DISCORD_BOT_TOKEN` को स्वतः पढ़ता है।

लागू करने के लिए पुनः आरंभ करें:

```bash
exit
fly machine restart <machine-id>
```

## 6) Gateway तक पहुँच

### Control UI

ब्राउज़र में खोलें:

```bash
fly open
```

या `https://my-openclaw.fly.dev/` पर जाएँ

प्रमाणीकरण के लिए अपना gateway टोकन (जो `OPENCLAW_GATEWAY_TOKEN` से मिला) पेस्ट करें।

### लॉग्स

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH कंसोल

```bash
fly ssh console
```

## समस्या-निवारण

### "App is not listening on expected address"

Gateway `0.0.0.0` के बजाय `127.0.0.1` से बाइंड हो रहा है।

**समाधान:** `fly.toml` में अपने प्रोसेस कमांड में `--bind lan` जोड़ें।

### हेल्थ चेक्स विफल / कनेक्शन अस्वीकृत

Fly कॉन्फ़िगर किए गए पोर्ट पर Gateway तक नहीं पहुँच पा रहा है।

**समाधान:** सुनिश्चित करें कि `internal_port` Gateway पोर्ट से मेल खाता है ( `--port 3000` या `OPENCLAW_GATEWAY_PORT=3000` सेट करें)।

### OOM / मेमोरी समस्याएँ

कंटेनर बार-बार रीस्टार्ट हो रहा है या किल हो रहा है। संकेत: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, या मौन रीस्टार्ट्स।

**समाधान:** `fly.toml` में मेमोरी बढ़ाएँ:

```toml
[[vm]]
  memory = "2048mb"
```

या किसी मौजूदा मशीन को अपडेट करें:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**टिप्पणी:** 512MB बहुत कम है। 1GB काम कर सकता है लेकिन लोड या विस्तृत लॉगिंग के साथ OOM हो सकता है। **2GB अनुशंसित है।**

### Gateway लॉक समस्याएँ

Gateway "already running" त्रुटियों के साथ शुरू होने से मना करता है।

यह तब होता है जब कंटेनर रीस्टार्ट होता है लेकिन PID लॉक फ़ाइल वॉल्यूम पर बनी रहती है।

**समाधान:** लॉक फ़ाइल हटाएँ:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

लॉक फ़ाइल `/data/gateway.*.lock` पर है (किसी सबडायरेक्टरी में नहीं)।

### कॉन्फ़िग पढ़ा नहीं जा रहा

यदि `--allow-unconfigured` का उपयोग कर रहे हैं, तो Gateway एक न्यूनतम कॉन्फ़िग बनाता है। आपका कस्टम कॉन्फ़िग `/data/openclaw.json` पर रीस्टार्ट पर पढ़ा जाना चाहिए।

सत्यापित करें कि कॉन्फ़िग मौजूद है:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH के माध्यम से कॉन्फ़िग लिखना

`fly ssh console -C` कमांड शेल रीडायरेक्शन का समर्थन नहीं करता। कॉन्फ़िग फ़ाइल लिखने के लिए:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**टिप्पणी:** यदि फ़ाइल पहले से मौजूद है तो `fly sftp` विफल हो सकता है। पहले हटाएँ:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### स्टेट स्थायी नहीं रह रहा

यदि रीस्टार्ट के बाद क्रेडेंशियल्स या सत्र खो जाते हैं, तो स्टेट डायरेक्टरी कंटेनर फ़ाइलसिस्टम पर लिख रही है।

**समाधान:** सुनिश्चित करें कि `fly.toml` में `OPENCLAW_STATE_DIR=/data` सेट है और पुनः डिप्लॉय करें।

## अपडेट्स

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### मशीन कमांड अपडेट करना

पूर्ण पुनः डिप्लॉय के बिना स्टार्टअप कमांड बदलने के लिए:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**टिप्पणी:** `fly deploy` के बाद, मशीन कमांड `fly.toml` में जो है उस पर रीसेट हो सकता है। यदि आपने मैनुअल बदलाव किए हैं, तो डिप्लॉय के बाद उन्हें फिर से लागू करें।

## निजी परिनियोजन (सुदृढ़)

डिफ़ॉल्ट रूप से, Fly सार्वजनिक IP आवंटित करता है, जिससे आपका Gateway `https://your-app.fly.dev` पर सुलभ होता है। यह सुविधाजनक है, लेकिन इसका अर्थ है कि आपका परिनियोजन इंटरनेट स्कैनर्स (Shodan, Censys, आदि) द्वारा खोजा जा सकता है।

**बिना किसी सार्वजनिक एक्सपोज़र** के सुदृढ़ परिनियोजन के लिए, निजी टेम्पलेट का उपयोग करें।

### निजी परिनियोजन कब उपयोग करें

- आप केवल **आउटबाउंड** कॉल/संदेश करते हैं (कोई इनबाउंड वेबहुक नहीं)
- किसी भी वेबहुक कॉलबैक के लिए **ngrok या Tailscale** टनल का उपयोग करते हैं
- ब्राउज़र के बजाय **SSH, प्रॉक्सी, या WireGuard** के माध्यम से Gateway एक्सेस करते हैं
- परिनियोजन को **इंटरनेट स्कैनर्स से छिपा** रखना चाहते हैं

### सेटअप

मानक कॉन्फ़िग के बजाय `fly.private.toml` का उपयोग करें:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

या किसी मौजूदा परिनियोजन को रूपांतरित करें:

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

इसके बाद, `fly ips list` में केवल `private` प्रकार का IP दिखना चाहिए:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### निजी परिनियोजन तक पहुँच

चूँकि कोई सार्वजनिक URL नहीं है, इनमें से किसी एक विधि का उपयोग करें:

**विकल्प 1: स्थानीय प्रॉक्सी (सबसे सरल)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**विकल्प 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**विकल्प 3: केवल SSH**

```bash
fly ssh console -a my-openclaw
```

### निजी परिनियोजन के साथ वेबहुक्स

यदि आपको सार्वजनिक एक्सपोज़र के बिना वेबहुक कॉलबैक (Twilio, Telnyx, आदि) चाहिए:

1. **ngrok टनल** — कंटेनर के भीतर या साइडकार के रूप में ngrok चलाएँ
2. **Tailscale Funnel** — Tailscale के माध्यम से विशिष्ट पथ उजागर करें
3. **केवल आउटबाउंड** — कुछ प्रदाता (Twilio) वेबहुक्स के बिना भी आउटबाउंड कॉल्स के लिए ठीक काम करते हैं

ngrok के साथ उदाहरण वॉइस-कॉल कॉन्फ़िग:

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

ngrok टनल कंटेनर के भीतर चलती है और Fly ऐप को उजागर किए बिना एक सार्वजनिक वेबहुक URL प्रदान करती है। फॉरवर्डेड होस्ट हेडर्स स्वीकार करने के लिए `webhookSecurity.allowedHosts` को सार्वजनिक टनल होस्टनेम पर सेट करें।

### सुरक्षा लाभ

| पहलू              | सार्वजनिक   | निजी             |
| ----------------- | ----------- | ---------------- |
| इंटरनेट स्कैनर्स  | खोजने योग्य | छिपा हुआ         |
| प्रत्यक्ष हमले    | संभव        | अवरुद्ध          |
| Control UI एक्सेस | ब्राउज़र    | प्रॉक्सी/VPN     |
| वेबहुक डिलीवरी    | प्रत्यक्ष   | टनल के माध्यम से |

## टिप्पणियाँ

- Fly.io **x86 आर्किटेक्चर** का उपयोग करता है (ARM नहीं)
- Dockerfile दोनों आर्किटेक्चर के साथ संगत है
- WhatsApp/Telegram ऑनबोर्डिंग के लिए `fly ssh console` का उपयोग करें
- स्थायी डेटा वॉल्यूम पर `/data` में रहता है
- Signal के लिए Java + signal-cli आवश्यक है; कस्टम इमेज का उपयोग करें और मेमोरी 2GB+ रखें।

## लागत

अनुशंसित कॉन्फ़िग (`shared-cpu-2x`, 2GB RAM) के साथ:

- उपयोग के अनुसार ~$10–15/माह
- फ्री टियर में कुछ अलाउंस शामिल हैं

विवरण के लिए [Fly.io pricing](https://fly.io/docs/about/pricing/) देखें।
