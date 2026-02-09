---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Fly.io Deployment

**Layunin:** OpenClaw Gateway na tumatakbo sa isang [Fly.io](https://fly.io) machine na may persistent storage, awtomatikong HTTPS, at access sa Discord/channel.

## Ano ang kailangan mo

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) na naka-install
- Fly.io account (puwede ang free tier)
- Model auth: Anthropic API key (o iba pang provider keys)
- Channel credentials: Discord bot token, Telegram token, atbp.

## Mabilis na ruta para sa baguhan

1. I-clone ang repo → i-customize ang `fly.toml`
2. Gumawa ng app + volume → mag-set ng secrets
3. Mag-deploy gamit ang `fly deploy`
4. Mag-SSH para gumawa ng config o gamitin ang Control UI

## 1) Gumawa ng Fly app

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tip:** Pumili ng rehiyong malapit sa iyo. Mga karaniwang opsyon: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2. I-configure ang fly.toml

I-edit ang `fly.toml` para tumugma sa pangalan ng app at mga kinakailangan mo.

**Paalala sa seguridad:** Ang default na config ay naglalantad ng isang pampublikong URL. Para sa mas pinatibay na deployment na walang pampublikong IP, tingnan ang [Private Deployment](#private-deployment-hardened) o gamitin ang `fly.private.toml`.

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

**Mga pangunahing setting:**

| Setting                        | Bakit                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Naka-bind sa `0.0.0.0` para maabot ng proxy ng Fly ang gateway                                          |
| `--allow-unconfigured`         | Nagsisimula nang walang config file (gagawa ka ng isa pagkatapos)                    |
| `internal_port = 3000`         | Dapat tumugma sa `--port 3000` (o `OPENCLAW_GATEWAY_PORT`) para sa Fly health checks |
| `memory = "2048mb"`            | 512MB ay masyadong maliit; 2GB ang inirerekomenda                                                       |
| `OPENCLAW_STATE_DIR = "/data"` | Pinapanatili ang state sa volume                                                                        |

## 3. Mag-set ng secrets

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

**Mga tala:**

- Ang non-loopback binds (`--bind lan`) ay nangangailangan ng `OPENCLAW_GATEWAY_TOKEN` para sa seguridad.
- Tratuhin ang mga token na ito na parang mga password.
- **Mas piliin ang env vars kaysa config file** para sa lahat ng API key at token. Pinananatili nitong wala ang mga secret sa `openclaw.json` kung saan maaari silang aksidenteng malantad o ma-log.

## 4. Mag-deploy

```bash
fly deploy
```

Ang unang deploy ay bumubuo ng Docker image (~2–3 minuto). Mas mabilis ang mga susunod na deploy.

Pagkatapos ng deployment, i-verify:

```bash
fly status
fly logs
```

Dapat mong makita ang:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Gumawa ng config file

Mag-SSH sa machine para gumawa ng tamang config:

```bash
fly ssh console
```

Gumawa ng config directory at file:

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

**Tandaan:** Kapag gumagamit ng `OPENCLAW_STATE_DIR=/data`, ang config path ay `/data/openclaw.json`.

**Tandaan:** Ang Discord token ay maaaring magmula sa alinman sa:

- Environment variable: `DISCORD_BOT_TOKEN` (inirerekomenda para sa secrets)
- Config file: `channels.discord.token`

Kung gumagamit ng env var, hindi na kailangang idagdag ang token sa config. Awtomatikong binabasa ng gateway ang `DISCORD_BOT_TOKEN`.

I-restart para ma-apply:

```bash
exit
fly machine restart <machine-id>
```

## 6. I-access ang Gateway

### Control UI

Buksan sa browser:

```bash
fly open
```

O bisitahin ang `https://my-openclaw.fly.dev/`

I-paste ang iyong gateway token (ang galing sa `OPENCLAW_GATEWAY_TOKEN`) para mag-authenticate.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH Console

```bash
fly ssh console
```

## Pag-troubleshoot

### "App is not listening on expected address"

Ang gateway ay naka-bind sa `127.0.0.1` sa halip na `0.0.0.0`.

**Ayusin:** Idagdag ang `--bind lan` sa iyong process command sa `fly.toml`.

### Health checks failing / connection refused

Hindi maabot ng Fly ang gateway sa naka-configure na port.

**Ayusin:** Tiyaking tumutugma ang `internal_port` sa gateway port (i-set ang `--port 3000` o `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Mga Isyu sa Memory

Patuloy na nagre-restart o napapatay ang container. Mga palatandaan: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, o tahimik na mga restart.

**Ayusin:** Taasan ang memory sa `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

O i-update ang isang umiiral na machine:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Tandaan:** Masyadong maliit ang 512MB. Maaaring gumana ang 1GB ngunit maaaring mag-OOM kapag may load o may verbose logging. **Inirerekomenda ang 2GB.**

### Mga Isyu sa Gateway Lock

Tumatangging mag-start ang Gateway na may mga error na "already running".

Nangyayari ito kapag nagre-restart ang container ngunit nananatili ang PID lock file sa volume.

**Ayusin:** Burahin ang lock file:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Ang lock file ay nasa `/data/gateway.*.lock` (wala sa subdirectory).

### Hindi Binabasa ang Config

Kung gumagamit ng `--allow-unconfigured`, gagawa ang gateway ng isang minimal na config. Ang iyong custom config sa `/data/openclaw.json` ay dapat basahin muli sa restart.

I-verify na umiiral ang config:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Pagsusulat ng Config via SSH

Hindi sinusuportahan ng `fly ssh console -C` na utos ang shell redirection. Para magsulat ng config file:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Tandaan:** Maaaring pumalya ang `fly sftp` kung umiiral na ang file. Burahin muna:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Hindi Nagpe-persist ang State

Kung nawawala ang credentials o sessions pagkatapos ng restart, ang state dir ay sumusulat sa container filesystem.

**Ayusin:** Tiyaking naka-set ang `OPENCLAW_STATE_DIR=/data` sa `fly.toml` at mag-redeploy.

## Mga Update

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Pag-update ng Machine Command

Kung kailangan mong baguhin ang startup command nang walang full redeploy:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Tandaan:** Pagkatapos ng `fly deploy`, maaaring mag-reset ang machine command sa kung ano ang nasa `fly.toml`. Kung gumawa ka ng mga manual na pagbabago, ilapat muli ang mga ito pagkatapos ng deploy.

## Private Deployment (Hardened)

Sa default, nag-a-allocate ang Fly ng mga pampublikong IP, na ginagawang maa-access ang iyong gateway sa `https://your-app.fly.dev`. Maginhawa ito ngunit nangangahulugan na ang iyong deployment ay natutuklasan ng mga internet scanner (Shodan, Censys, atbp.).

Para sa hardened na deployment na **walang public exposure**, gamitin ang private template.

### Kailan gagamit ng private deployment

- Gumagawa ka lang ng **outbound** calls/mensahe (walang inbound webhooks)
- Gumagamit ka ng **ngrok o Tailscale** tunnels para sa anumang webhook callbacks
- Ina-access mo ang gateway via **SSH, proxy, o WireGuard** sa halip na browser
- Gusto mong **nakatago sa internet scanners** ang deployment

### Setup

Gamitin ang `fly.private.toml` sa halip na standard config:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

O i-convert ang isang umiiral na deployment:

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

Pagkatapos nito, dapat ipakita ng `fly ips list` ang isang `private` type IP lamang:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Pag-access sa private deployment

Dahil walang public URL, gamitin ang isa sa mga paraang ito:

**Opsyon 1: Local proxy (pinakasimple)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Opsyon 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Opsyon 3: SSH lamang**

```bash
fly ssh console -a my-openclaw
```

### Mga webhook sa private deployment

Kung kailangan mo ng mga webhook callback (Twilio, Telnyx, atbp.) nang walang pampublikong exposure:

1. **ngrok tunnel** – Patakbuhin ang ngrok sa loob ng container o bilang sidecar
2. **Tailscale Funnel** – Ilantad ang mga partikular na path via Tailscale
3. **Outbound-only** – Gumagana nang maayos ang ilang provider (Twilio) para sa outbound calls nang walang webhooks

Halimbawang voice-call config gamit ang ngrok:

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

Ang ngrok tunnel ay tumatakbo sa loob ng container at nagbibigay ng pampublikong webhook URL nang hindi inilalantad ang Fly app mismo. 2. Itakda ang `webhookSecurity.allowedHosts` sa pampublikong tunnel hostname para tanggapin ang mga forwarded host header.

### Mga benepisyo sa seguridad

| Aspeto                | Public       | Private    |
| --------------------- | ------------ | ---------- |
| Internet scanners     | Nadidiskubre | Nakatago   |
| Direktang atake       | Posible      | Naka-block |
| Access sa Control UI  | Browser      | Proxy/VPN  |
| Paghahatid ng webhook | Direkta      | Via tunnel |

## Mga Tala

- Gumagamit ang Fly.io ng **x86 architecture** (hindi ARM)
- Compatible ang Dockerfile sa parehong architecture
- Para sa WhatsApp/Telegram onboarding, gamitin ang `fly ssh console`
- Ang persistent data ay nasa volume sa `/data`
- Nangangailangan ang Signal ng Java + signal-cli; gumamit ng custom image at panatilihin ang memory sa 2GB+.

## Gastos

Sa inirerekomendang config (`shared-cpu-2x`, 2GB RAM):

- ~$10–15/buwan depende sa paggamit
- May kasamang ilang allowance ang free tier

Tingnan ang [Fly.io pricing](https://fly.io/docs/about/pricing/) para sa mga detalye.
