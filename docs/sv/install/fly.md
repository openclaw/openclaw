---
title: Fly.io
description: Distribuera OpenClaw på Fly.io
---

# Fly.io-distribution

**Mål:** OpenClaw Gateway körs på en [Fly.io](https://fly.io)-maskin med beständig lagring, automatisk HTTPS och Discord/kanalåtkomst.

## Vad du behöver

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installerad
- Fly.io-konto (gratisnivån fungerar)
- Modellautentisering: Anthropic API-nyckel (eller andra leverantörsnycklar)
- Kanaluppgifter: Discord-bot-token, Telegram-token, osv.

## Snabb väg för nybörjare

1. Klona repot → anpassa `fly.toml`
2. Skapa app + volym → sätt hemligheter
3. Distribuera med `fly deploy`
4. SSH:a in för att skapa konfig eller använd Control UI

## 1) Skapa Fly-appen

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tips:** Välj en region nära dig. Vanliga alternativ: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2. Konfigurera fly.toml

Redigera `fly.toml` så att den matchar ditt appnamn och dina krav.

**Säkerhetsanteckning:** Standardkonfigurationen exponerar en publik URL. För en härdad distribution utan offentlig IP-adress, se [Privat distribution](#private-deployment-hardened) eller använd `fly.private.toml`.

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

**Viktiga inställningar:**

| Inställning                    | Varför                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `--bind lan`                   | Binder till `0.0.0.0` så att Flys proxy kan nå gatewayen                                               |
| `--allow-unconfigured`         | Startar utan en konfigfil (du skapar en senare)                                     |
| `internal_port = 3000`         | Måste matcha `--port 3000` (eller `OPENCLAW_GATEWAY_PORT`) för Flys hälsokontroller |
| `memory = "2048mb"`            | 512MB är för lite; 2GB rekommenderas                                                                   |
| `OPENCLAW_STATE_DIR = "/data"` | Beständig lagring av tillstånd på volymen                                                              |

## 3. Sätt hemligheter

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

**Noteringar:**

- Icke-loopback-bindningar (`--bind lan`) kräver `OPENCLAW_GATEWAY_TOKEN` av säkerhetsskäl.
- Behandla dessa token som lösenord.
- **Föredrar env vars över konfigurationsfil** för alla API-nycklar och tokens. Detta håller hemligheter från `openclaw.json` där de kan av misstag exponeras eller loggas.

## 4. Distribuera

```bash
fly deploy
```

Först distribuera bygger Docker-bilden (~2-3 minuter). Efterföljande distributioner är snabbare.

Efter distribution, verifiera:

```bash
fly status
fly logs
```

Du bör se:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Skapa konfigfil

SSH:a in i maskinen för att skapa en korrekt konfig:

```bash
fly ssh console
```

Skapa konfigkatalogen och filen:

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

**Obs:** Med `OPENCLAW_STATE_DIR=/data` är konfigsökvägen `/data/openclaw.json`.

**Obs:** Discord-token kan komma från antingen:

- Miljövariabel: `DISCORD_BOT_TOKEN` (rekommenderas för hemligheter)
- Konfigfil: `channels.discord.token`

Om du använder env var, behöver du inte lägga till token för att konfigurera. Gateway läser `DISCORD_BOT_TOKEN` automatiskt.

Starta om för att tillämpa:

```bash
exit
fly machine restart <machine-id>
```

## 6. Åtkomst till Gateway

### Control UI

Öppna i webbläsare:

```bash
fly open
```

Eller besök `https://my-openclaw.fly.dev/`

Klistra in din gateway-token (den från `OPENCLAW_GATEWAY_TOKEN`) för att autentisera.

### Loggar

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH-konsol

```bash
fly ssh console
```

## Felsökning

### ”App is not listening on expected address”

Gatewayen binder till `127.0.0.1` istället för `0.0.0.0`.

**Åtgärd:** Lägg till `--bind lan` i ditt processkommando i `fly.toml`.

### Hälsokontroller misslyckas / anslutning nekas

Fly kan inte nå gatewayen på den konfigurerade porten.

**Åtgärd:** Säkerställ att `internal_port` matchar gateway-porten (sätt `--port 3000` eller `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / Minnesproblem

Behållare fortsätter att starta om eller bli dödad. Skyltar: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, eller tyst omstart.

**Åtgärd:** Öka minnet i `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Eller uppdatera en befintlig maskin:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Obs:** 512MB är för litet. 1GB kan fungera men kan OOM under belastning eller med verbose loggning. **2GB rekommenderas.**

### Gateway-låsproblem

Gatewayen vägrar starta med ”already running”-fel.

Detta händer när containern startar om men PID-låsfilen finns kvar på volymen.

**Åtgärd:** Ta bort låsfilen:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Låsfilen finns på `/data/gateway.*.lock` (inte i en underkatalog).

### Konfig läses inte

Om du använder `--allow-unconfigured`, skapar gateway en minimal konfiguration. Din anpassade konfiguration på `/data/openclaw.json` ska läsas vid omstart.

Verifiera att konfigen finns:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Skriva konfig via SSH

Kommandot `fly ssh console -C` stöder inte skalomdirigering. För att skriva en konfigurationsfil:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Obs:** 'fly sftp' kan misslyckas om filen redan finns. Ta bort först:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Tillstånd sparas inte

Om du tappar uppgifter eller sessioner efter en omstart skrivs tillståndskatalogen till containerns filsystem.

**Åtgärd:** Säkerställ att `OPENCLAW_STATE_DIR=/data` är satt i `fly.toml` och distribuera om.

## Uppdateringar

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Uppdatera maskinkommando

Om du behöver ändra startkommandot utan full omdistribution:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Obs:** Efter `fly deploy`, kan maskinkommandot återställas till vad som finns i `fly.toml`. Om du gjort manuella ändringar, åter tillämpa dem efter distribution.

## Privat distribution (Härdad)

Som standard, Fly allokerar offentliga IP-adresser, vilket gör din gateway tillgänglig på `https://your-app.fly.dev`. Detta är bekvämt men innebär att din distribution är upptäckbar av internet-skannrar (Shodan, Censys, etc.).

För en härdad distribution med **ingen offentlig exponering**, använd den privata mallen.

### När ska privat distribution användas

- Du gör endast **utgående** anrop/meddelanden (inga inkommande webhooks)
- Du använder **ngrok eller Tailscale**-tunnlar för webhook-callbacks
- Du når gatewayen via **SSH, proxy eller WireGuard** istället för webbläsare
- Du vill att distributionen ska vara **dold för internetscanners**

### Konfigurering

Använd `fly.private.toml` istället för standardkonfigen:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Eller konvertera en befintlig distribution:

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

Efter detta ska `fly ips list` endast visa en `private`-typ av IP:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Åtkomst till privat distribution

Eftersom det inte finns någon offentlig URL, använd en av dessa metoder:

**Alternativ 1: Lokal proxy (enklast)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Alternativ 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Alternativ 3: Endast SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks med privat distribution

Om du behöver webhook callbacks (Twilio, Telnyx, etc.) utan offentlig exponering:

1. **ngrok-tunnel** – Kör ngrok i containern eller som sidecar
2. **Tailscale Funnel** – Exponera specifika sökvägar via Tailscale
3. **Endast utgående** – Vissa leverantörer (Twilio) fungerar bra för utgående samtal utan webhooks

Exempel på röstkonfig med ngrok:

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

Den ngrok tunneln körs inne i behållaren och ger en publik webhook URL utan att exponera Fly appen själv. Ange `webhookSecurity.allowedHosts` till det publika tunnelns värdnamn så vidarekopplade värdhuvuden accepteras.

### Säkerhetsfördelar

| Aspekt             | Offentlig  | Privat     |
| ------------------ | ---------- | ---------- |
| Internetscanners   | Upptäckbar | Dold       |
| Direkta attacker   | Möjliga    | Blockerade |
| Control UI-åtkomst | Webbläsare | Proxy/VPN  |
| Webhook-leverans   | Direkt     | Via tunnel |

## Noteringar

- Fly.io använder **x86-arkitektur** (inte ARM)
- Dockerfile är kompatibel med båda arkitekturerna
- För WhatsApp/Telegram-introduktion, använd `fly ssh console`
- Beständig data finns på volymen vid `/data`
- Signal kräver Java + signal-cli; använd en anpassad image och håll minnet på 2GB+.

## Kostnad

Med den rekommenderade konfigen (`shared-cpu-2x`, 2GB RAM):

- ~10–15 USD/månad beroende på användning
- Gratisnivån inkluderar viss tilldelning

Se [Fly.io-prissättning](https://fly.io/docs/about/pricing/) för detaljer.
