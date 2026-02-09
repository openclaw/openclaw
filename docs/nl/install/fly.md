---
title: Fly.io
description: OpenClaw implementeren op Fly.io
---

# Fly.io-implementatie

**Doel:** OpenClaw Gateway draaiend op een [Fly.io](https://fly.io)-machine met persistente opslag, automatische HTTPS en Discord-/kanaaltoegang.

## Wat je nodig hebt

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) geïnstalleerd
- Fly.io-account (gratis tier werkt)
- Modelauthenticatie: Anthropic API-sleutel (of andere provider-sleutels)
- Kanaalreferenties: Discord-bot-token, Telegram-token, enz.

## Snelle route voor beginners

1. Repo klonen → `fly.toml` aanpassen
2. App + volume aanmaken → secrets instellen
3. Deployen met `fly deploy`
4. Via SSH inloggen om config te maken of de Control UI gebruiken

## 1) De Fly-app maken

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tip:** Kies een regio dicht bij jou. Veelgebruikte opties: `lhr` (Londen), `iad` (Virginia), `sjc` (San Jose).

## 2. fly.toml configureren

Bewerk `fly.toml` zodat deze overeenkomt met je app-naam en vereisten.

**Beveiligingsnotitie:** De standaardconfig stelt een publieke URL bloot. Voor een geharde implementatie zonder openbaar IP, zie [Private Deployment](#private-deployment-hardened) of gebruik `fly.private.toml`.

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

**Belangrijke instellingen:**

| Instelling                     | Waarom                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Bindt aan `0.0.0.0` zodat de proxy van Fly de Gateway kan bereiken                                        |
| `--allow-unconfigured`         | Start zonder configbestand (je maakt er later een)                                     |
| `internal_port = 3000`         | Moet overeenkomen met `--port 3000` (of `OPENCLAW_GATEWAY_PORT`) voor Fly-healthchecks |
| `memory = "2048mb"`            | 512MB is te klein; 2GB aanbevolen                                                                         |
| `OPENCLAW_STATE_DIR = "/data"` | Houdt status persistent op het volume                                                                     |

## 3. Secrets instellen

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

**Notities:**

- Niet-loopback binds (`--bind lan`) vereisen `OPENCLAW_GATEWAY_TOKEN` voor beveiliging.
- Behandel deze tokens als wachtwoorden.
- **Geef de voorkeur aan omgevingsvariabelen boven het configbestand** voor alle API-sleutels en tokens. Zo blijven secrets uit `openclaw.json`, waar ze per ongeluk blootgesteld of gelogd kunnen worden.

## 4. Deployen

```bash
fly deploy
```

De eerste deploy bouwt het Docker-image (~2–3 minuten). Volgende deploys zijn sneller.

Controleer na de deploy:

```bash
fly status
fly logs
```

Je zou moeten zien:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Configbestand maken

Log via SSH in op de machine om een juiste config te maken:

```bash
fly ssh console
```

Maak de configmap en het bestand aan:

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

**Let op:** Met `OPENCLAW_STATE_DIR=/data` is het configpad `/data/openclaw.json`.

**Let op:** Het Discord-token kan uit één van de volgende bronnen komen:

- Omgevingsvariabele: `DISCORD_BOT_TOKEN` (aanbevolen voor secrets)
- Configbestand: `channels.discord.token`

Bij gebruik van de env var hoef je geen token aan de config toe te voegen. De Gateway leest `DISCORD_BOT_TOKEN` automatisch.

Herstarten om toe te passen:

```bash
exit
fly machine restart <machine-id>
```

## 6. Toegang tot de Gateway

### Control UI

Open in de browser:

```bash
fly open
```

Of ga naar `https://my-openclaw.fly.dev/`

Plak je gateway-token (die uit `OPENCLAW_GATEWAY_TOKEN`) om te authenticeren.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH-console

```bash
fly ssh console
```

## Problemen oplossen

### "App is not listening on expected address"

De Gateway bindt aan `127.0.0.1` in plaats van `0.0.0.0`.

**Oplossing:** Voeg `--bind lan` toe aan je process-commando in `fly.toml`.

### Healthchecks falen / verbinding geweigerd

Fly kan de Gateway niet bereiken op de geconfigureerde poort.

**Oplossing:** Zorg dat `internal_port` overeenkomt met de Gateway-poort (stel `--port 3000` of `OPENCLAW_GATEWAY_PORT=3000` in).

### OOM / geheugenproblemen

De container blijft herstarten of wordt beëindigd. Signalen: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, of stille herstarts.

**Oplossing:** Verhoog het geheugen in `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Of werk een bestaande machine bij:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Let op:** 512MB is te klein. 1GB kan werken maar kan OOM raken onder belasting of bij uitgebreide logging. **2GB wordt aanbevolen.**

### Gateway-lockproblemen

De Gateway weigert te starten met fouten als "already running".

Dit gebeurt wanneer de container herstart maar het PID-lockbestand op het volume blijft bestaan.

**Oplossing:** Verwijder het lockbestand:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Het lockbestand staat op `/data/gateway.*.lock` (niet in een submap).

### Config wordt niet gelezen

Bij gebruik van `--allow-unconfigured` maakt de Gateway een minimale config aan. Je aangepaste config op `/data/openclaw.json` zou bij herstart gelezen moeten worden.

Controleer of de config bestaat:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Config schrijven via SSH

Het commando `fly ssh console -C` ondersteunt geen shell-redirection. Om een configbestand te schrijven:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Let op:** `fly sftp` kan falen als het bestand al bestaat. Verwijder het eerst:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Staat niet Persisterend

Als je na een herstart referenties of sessies verliest, schrijft de statusmap naar het containerbestandssysteem.

**Oplossing:** Zorg dat `OPENCLAW_STATE_DIR=/data` is ingesteld in `fly.toml` en deploy opnieuw.

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

### Machine-commando bijwerken

Als je het opstartcommando wilt wijzigen zonder een volledige redeploy:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Let op:** Na `fly deploy` kan het machine-commando worden teruggezet naar wat in `fly.toml` staat. Als je handmatige wijzigingen hebt gemaakt, pas ze na de deploy opnieuw toe.

## Private Deployment (gehard)

Standaard wijst Fly publieke IP’s toe, waardoor je Gateway toegankelijk is via `https://your-app.fly.dev`. Dit is handig, maar betekent dat je implementatie vindbaar is voor internetscanners (Shodan, Censys, enz.).

Voor een geharde implementatie met **geen publieke blootstelling**, gebruik het private template.

### Wanneer private deployment gebruiken

- Je doet alleen **uitgaande** oproepen/berichten (geen inkomende webhooks)
- Je gebruikt **ngrok- of Tailscale**-tunnels voor webhook-callbacks
- Je benadert de Gateway via **SSH, proxy of WireGuard** in plaats van de browser
- Je wilt de implementatie **verborgen houden voor internetscanners**

### Installatie

Gebruik `fly.private.toml` in plaats van de standaardconfig:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Of converteer een bestaande implementatie:

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

Hierna zou `fly ips list` alleen een IP van het type `private` moeten tonen:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Toegang tot een private deployment

Omdat er geen publieke URL is, gebruik één van deze methoden:

**Optie 1: Lokale proxy (simpelst)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Optie 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Optie 3: Alleen SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks met private deployment

Als je webhook-callbacks nodig hebt (Twilio, Telnyx, enz.) zonder publieke blootstelling:

1. **ngrok-tunnel** – Draai ngrok in de container of als sidecar
2. **Tailscale Funnel** – Stel specifieke paden bloot via Tailscale
3. **Alleen uitgaand** – Sommige providers (Twilio) werken prima voor uitgaande oproepen zonder webhooks

Voorbeeld voice-call-config met ngrok:

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

De ngrok-tunnel draait in de container en levert een publieke webhook-URL zonder de Fly-app zelf bloot te stellen. Stel `webhookSecurity.allowedHosts` in op de publieke tunnel-hostname zodat doorgestuurde host-headers worden geaccepteerd.

### Beveiligingsvoordelen

| Aspect             | Publiek  | Privé       |
| ------------------ | -------- | ----------- |
| Internetscanners   | Vindbaar | Hidden      |
| Directe aanvallen  | Mogelijk | Geblokkeerd |
| Control UI-toegang | Browser  | Proxy/VPN   |
| Webhook-bezorging  | Direct   | Via tunnel  |

## Notities

- Fly.io gebruikt **x86-architectuur** (geen ARM)
- Het Dockerfile is compatibel met beide architecturen
- Voor WhatsApp-/Telegram-onboarding, gebruik `fly ssh console`
- Persistente data staat op het volume op `/data`
- Signal vereist Java + signal-cli; gebruik een custom image en houd het geheugen op 2GB+.

## Kosten

Met de aanbevolen config (`shared-cpu-2x`, 2GB RAM):

- ~$10–15/maand afhankelijk van gebruik
- De gratis tier bevat enige tegoeden

Zie [Fly.io-prijzen](https://fly.io/docs/about/pricing/) voor details.
