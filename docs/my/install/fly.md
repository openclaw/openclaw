---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Fly.io တွင် တပ်ဆင်အသုံးပြုခြင်း

**ရည်မှန်းချက်:** OpenClaw Gateway ကို [Fly.io](https://fly.io) မော်စင်ပေါ်တွင် အမြဲတမ်းသိုလှောင်မှု၊ အလိုအလျောက် HTTPS နှင့် Discord/ချန်နယ် ဝင်ရောက်အသုံးပြုနိုင်မှုတို့ဖြင့် လည်ပတ်စေခြင်း။

## လိုအပ်သည်များ

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) ကို ထည့်သွင်းပြီးသားဖြစ်ရမည်
- Fly.io အကောင့် (အခမဲ့အဆင့်ဖြင့်လည်း အလုပ်လုပ်သည်)
- မော်ဒယ် အတည်ပြုချက်: Anthropic API ကီး (သို့မဟုတ် အခြား ပံ့ပိုးသူ ကီးများ)
- ချန်နယ် အထောက်အထားများ: Discord ဘော့တ် တိုကင်၊ Telegram တိုကင် စသည်တို့

## စတင်အသုံးပြုသူများအတွက် အမြန်လမ်းကြောင်း

1. Repo ကို Clone လုပ် → `fly.toml` ကို စိတ်ကြိုက်ပြင်ဆင်
2. App + volume ဖန်တီး → secrets များ သတ်မှတ်
3. `fly deploy` ဖြင့် Deploy လုပ်
4. Config ဖန်တီးရန် SSH ဝင် (သို့) Control UI ကို အသုံးပြု

## 1) Fly app ဖန်တီးခြင်း

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**အကြံပြုချက်:** သင့်နီးစပ်ရာ region ကို ရွေးပါ။ အသုံးများတဲ့ option များ: `lhr` (London), `iad` (Virginia), `sjc` (San Jose)။

## 2. fly.toml ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

`fly.toml` ကို သင့် app အမည်နှင့် လိုအပ်ချက်များနှင့် ကိုက်ညီအောင် ပြင်ဆင်ပါ။

**လုံခြုံရေး သတိပေးချက်:** မူလ config က public URL တစ်ခုကို ဖွင့်ထားပါတယ်။ Public IP မပါဘဲ ပိုမိုခိုင်မာတဲ့ deployment အတွက် [Private Deployment](#private-deployment-hardened) ကို ကြည့်ပါ သို့မဟုတ် `fly.private.toml` ကို အသုံးပြုပါ။

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

**အဓိက သတ်မှတ်ချက်များ:**

| Setting                        | အကြောင်းရင်း                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Fly ၏ proxy က gateway ကို ရောက်ရှိနိုင်ရန် `0.0.0.0` သို့ bind လုပ်ပေးသည်                                      |
| `--allow-unconfigured`         | Config ဖိုင်မပါဘဲ စတင်သည် (နောက်မှ ဖန်တီးမည်)                                               |
| `internal_port = 3000`         | Fly health checks အတွက် `--port 3000` (သို့မဟုတ် `OPENCLAW_GATEWAY_PORT`) နှင့် ကိုက်ညီရမည် |
| `memory = "2048mb"`            | 512MB သည် မလုံလောက်ပါ; 2GB ကို အကြံပြုသည်                                                                      |
| `OPENCLAW_STATE_DIR = "/data"` | Volume ပေါ်တွင် အခြေအနေကို အမြဲတမ်းသိုလှောင်ထားသည်                                                             |

## 3. Secrets များ သတ်မှတ်ခြင်း

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

**မှတ်ချက်များ:**

- Non-loopback bind (`--bind lan`) များအတွက် လုံခြုံရေးအတွက် `OPENCLAW_GATEWAY_TOKEN` လိုအပ်သည်။
- ဤတိုကင်များကို စကားဝှက်များကဲ့သို့ ထိန်းသိမ်းပါ။
- API key နဲ့ token အားလုံးအတွက် **config file ထက် env vars ကို ဦးစားပေးပါ**။ ဒါကြောင့် `openclaw.json` ထဲမှာ secret များ မသိမ်းရဘဲ မတော်တဆ ဖော်ထုတ်ခြင်း သို့မဟုတ် log ထဲ ပါသွားခြင်းကို ရှောင်ရှားနိုင်ပါတယ်။

## 4. Deploy လုပ်ခြင်း

```bash
fly deploy
```

ပထမဆုံး deploy မှာ Docker image ကို build လုပ်ရပြီး (~၂–၃ မိနစ်) ကြာပါတယ်။ နောက်တစ်ခါ deploy များက ပိုမိုမြန်ဆန်ပါလိမ့်မယ်။

Deploy ပြီးနောက် အတည်ပြုရန်:

```bash
fly status
fly logs
```

အောက်ပါအတိုင်း မြင်ရမည်ဖြစ်သည်—

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Config ဖိုင် ဖန်တီးခြင်း

စနစ်ထဲသို့ SSH ဝင်၍ သင့်တော်သော config ကို ဖန်တီးပါ—

```bash
fly ssh console
```

Config ဒိုင်ရက်ထရီနှင့် ဖိုင်ကို ဖန်တီးပါ—

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

**မှတ်ချက်:** `OPENCLAW_STATE_DIR=/data` ကို အသုံးပြုပါက config လမ်းကြောင်းမှာ `/data/openclaw.json` ဖြစ်သည်။

**မှတ်ချက်:** Discord တိုကင်ကို အောက်ပါနည်းလမ်း နှစ်မျိုးထဲမှ တစ်ခုဖြင့် ထည့်နိုင်သည်—

- Environment variable: `DISCORD_BOT_TOKEN` (လျှို့ဝှက်ချက်များအတွက် အကြံပြု)
- Config ဖိုင်: `channels.discord.token`

env var ကို သုံးရင် token ကို config ထဲ ထည့်စရာ မလိုပါ။ Gateway က `DISCORD_BOT_TOKEN` ကို အလိုအလျောက် ဖတ်ယူပါတယ်။

အပြောင်းအလဲများ အသက်သွင်းရန် ပြန်စတင်ပါ—

```bash
exit
fly machine restart <machine-id>
```

## 6. Gateway သို့ ဝင်ရောက်ခြင်း

### Control UI

Browser တွင် ဖွင့်ပါ—

```bash
fly open
```

သို့မဟုတ် `https://my-openclaw.fly.dev/` ကို သွားပါ။

အတည်ပြုရန် Gateway တိုကင် (`OPENCLAW_GATEWAY_TOKEN` မှ ရရှိသည့် တိုကင်) ကို ထည့်ပါ။

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH Console

```bash
fly ssh console
```

## Troubleshooting

### "App is not listening on expected address"

Gateway သည် `0.0.0.0` အစား `127.0.0.1` သို့ bind လုပ်နေသည်။

**ဖြေရှင်းနည်း:** `fly.toml` ထဲရှိ process command သို့ `--bind lan` ကို ထည့်ပါ။

### Health checks မအောင်မြင်ခြင်း / connection refused

Fly သည် သတ်မှတ်ထားသော port ပေါ်ရှိ gateway ကို မရောက်ရှိနိုင်ပါ။

**ဖြေရှင်းနည်း:** `internal_port` သည် gateway port နှင့် ကိုက်ညီနေကြောင်း အတည်ပြုပါ (`--port 3000` သို့မဟုတ် `OPENCLAW_GATEWAY_PORT=3000` ကို သတ်မှတ်ပါ)။

### OOM / Memory ပြဿနာများ

Container က အမြဲ restart ဖြစ်နေတယ် သို့မဟုတ် kill ခံနေရပါတယ်။ လက္ခဏာများ: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, သို့မဟုတ် အသံမရှိဘဲ restart ဖြစ်ခြင်း။

**ဖြေရှင်းနည်း:** `fly.toml` ထဲတွင် memory ကို တိုးမြှင့်ပါ—

```toml
[[vm]]
  memory = "2048mb"
```

သို့မဟုတ် ရှိပြီးသား machine ကို အပ်ဒိတ်လုပ်ပါ—

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**မှတ်ချက်:** 512MB က အရမ်းသေးလွန်းပါတယ်။ 1GB နဲ့ အလုပ်လုပ်နိုင်ပေမယ့် load များတဲ့အခါ သို့မဟုတ် verbose logging နဲ့ဆို OOM ဖြစ်နိုင်ပါတယ်။ **2GB ကို အကြံပြုပါတယ်။**

### Gateway Lock ပြဿနာများ

Gateway သည် "already running" အမှားများဖြင့် စတင်ရန် ငြင်းပယ်သည်။

Container ပြန်စတင်သော်လည်း PID lock ဖိုင်သည် volume ပေါ်တွင် ကျန်နေသောအခါ ဖြစ်ပေါ်သည်။

**ဖြေရှင်းနည်း:** Lock ဖိုင်ကို ဖျက်ပါ—

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Lock ဖိုင်သည် `/data/gateway.*.lock` တွင် ရှိသည် (subdirectory မဟုတ်ပါ)။

### Config ကို မဖတ်ရခြင်း

`--allow-unconfigured` ကို သုံးရင် gateway က minimal config တစ်ခုကို ဖန်တီးပေးပါတယ်။ `/data/openclaw.json` မှာရှိတဲ့ သင့် custom config ကို restart ပြုလုပ်တဲ့အခါ ဖတ်သင့်ပါတယ်။

Config ရှိကြောင်း အတည်ပြုပါ—

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### SSH ဖြင့် Config ရေးသားခြင်း

`fly ssh console -C` command က shell redirection ကို မထောက်ပံ့ပါ။ config ဖိုင် ရေးဖို့:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**မှတ်ချက်:** ဖိုင်ရှိပြီးသား ဖြစ်ရင် `fly sftp` မအောင်မြင်နိုင်ပါ။ အရင် ဖျက်ပါ:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### State မအမြဲတမ်းသိုလှောင်ခြင်း

Restart ပြီးနောက် အထောက်အထားများ သို့မဟုတ် ဆက်ရှင်များ ပျောက်သွားပါက state dir သည် container filesystem သို့ ရေးနေခြင်း ဖြစ်နိုင်သည်။

**ဖြေရှင်းနည်း:** `fly.toml` ထဲတွင် `OPENCLAW_STATE_DIR=/data` ကို သတ်မှတ်ထားကြောင်း အတည်ပြုပြီး redeploy လုပ်ပါ။

## Updates

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Machine Command ကို အပ်ဒိတ်လုပ်ခြင်း

အပြည့်အဝ redeploy မလုပ်ဘဲ startup command ကို ပြောင်းလဲလိုပါက—

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**မှတ်ချက်:** `fly deploy` ပြီးတဲ့နောက် machine command က `fly.toml` ထဲမှာ ရှိတဲ့အတိုင်း ပြန် reset ဖြစ်နိုင်ပါတယ်။ Manual ပြောင်းလဲမှုတွေ လုပ်ထားရင် deploy ပြီးတဲ့နောက် ပြန်လည် 적용 လုပ်ပါ။

## Private Deployment (Hardened)

မူလအတိုင်း Fly က public IP များ allocate လုပ်ပေးပြီး သင့် gateway ကို `https://your-app.fly.dev` မှာ ဝင်ရောက်နိုင်စေပါတယ်။ ဒါက အဆင်ပြေသော်လည်း သင့် deployment ကို internet scanner များ (Shodan, Censys စသည်) က ရှာတွေ့နိုင်တယ်ဆိုတဲ့ အဓိပ္ပါယ်ပါ။

**အများပြည်သူသို့ မထုတ်ဖော်သည့်** အားကောင်းစေသော တပ်ဆင်မှုအတွက် private template ကို အသုံးပြုပါ။

### Private deployment ကို သုံးသင့်သည့်အချိန်များ

- **အပြင်သို့သာ** ခေါ်ဆိုမှုများ/မက်ဆေ့ချ်များ ပြုလုပ်သည် (inbound webhooks မလို)
- Webhook callbacks အတွက် **ngrok သို့မဟုတ် Tailscale** တန်နယ်များကို အသုံးပြုသည်
- Browser မဟုတ်ဘဲ **SSH, proxy, သို့မဟုတ် WireGuard** ဖြင့် gateway ကို ဝင်ရောက်အသုံးပြုသည်
- Deployment ကို **အင်တာနက် စကင်နာများမှ ဖုံးကွယ်ထားလို** သည်

### Setup

စံ config အစား `fly.private.toml` ကို အသုံးပြုပါ—

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

သို့မဟုတ် ရှိပြီးသား deployment ကို ပြောင်းလဲပါ—

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

ထို့နောက် `fly ips list` တွင် `private` အမျိုးအစား IP သာ ပြသရမည်—

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Private deployment သို့ ဝင်ရောက်ခြင်း

အများပြည်သူ URL မရှိသောကြောင့် အောက်ပါနည်းလမ်းများထဲမှ တစ်ခုကို အသုံးပြုပါ—

**Option 1: Local proxy (အလွယ်ဆုံး)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Option 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Option 3: SSH သာ**

```bash
fly ssh console -a my-openclaw
```

### Private deployment နှင့် Webhooks

webhook callbacks (Twilio, Telnyx စသည်) လိုအပ်ရင် Public exposure မရှိဘဲ:

1. **ngrok tunnel** — container အတွင်း သို့မဟုတ် sidecar အဖြစ် ngrok ကို ပြေးပါ
2. **Tailscale Funnel** — Tailscale ဖြင့် လမ်းကြောင်းအချို့ကိုသာ ထုတ်ဖော်ပါ
3. **Outbound-only** — Provider အချို့ (Twilio) သည် webhook မလိုဘဲ အပြင်သို့သာ ခေါ်ဆိုမှုများအတွက် အဆင်ပြေသည်

ngrok ဖြင့် အသံခေါ်ဆိုမှု config ဥပမာ—

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

ngrok tunnel ကို container အတွင်းမှာ run လုပ်ပြီး Fly app ကို မဖော်ထုတ်ဘဲ public webhook URL တစ်ခု ပေးပါတယ်။ Forward လုပ်တဲ့ host header များကို လက်ခံနိုင်ဖို့ `webhookSecurity.allowedHosts` ကို public tunnel hostname အဖြစ် သတ်မှတ်ပါ။

### လုံခြုံရေး အကျိုးကျေးဇူးများ

| အချက်အလက်              | Public             | Private         |
| ---------------------- | ------------------ | --------------- |
| Internet scanners      | ရှာဖွေတွေ့ရှိနိုင် | ဖုံးကွယ်ထား     |
| Direct attacks         | ဖြစ်နိုင်          | ပိတ်ဆို့ထား     |
| Control UI ဝင်ရောက်မှု | Browser            | Proxy/VPN       |
| Webhook ပေးပို့မှု     | တိုက်ရိုက်         | တန်နယ်မှတစ်ဆင့် |

## Notes

- Fly.io သည် **x86 architecture** ကို အသုံးပြုသည် (ARM မဟုတ်)
- Dockerfile သည် architecture နှစ်မျိုးလုံးနှင့် ကိုက်ညီသည်
- WhatsApp/Telegram onboarding အတွက် `fly ssh console` ကို အသုံးပြုပါ
- အမြဲတမ်းဒေတာများကို volume ပေါ်ရှိ `/data` တွင် သိမ်းဆည်းထားသည်
- Signal သည် Java + signal-cli လိုအပ်သည်; custom image ကို အသုံးပြုပြီး memory ကို 2GB+ ထားပါ။

## Cost

အကြံပြုထားသော config (`shared-cpu-2x`, 2GB RAM) ဖြင့်—

- အသုံးပြုမှုပေါ်မူတည်၍ လစဉ် ~$10–15
- Free tier တွင် အချို့သော allowance ပါဝင်သည်

အသေးစိတ်အတွက် [Fly.io pricing](https://fly.io/docs/about/pricing/) ကို ကြည့်ပါ။
