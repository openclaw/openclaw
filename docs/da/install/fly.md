---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Fly.io-udrulning

**Mål:** OpenClaw Gateway kører på en [Fly.io](https://fly.io)-maskine med vedvarende lagring, automatisk HTTPS og Discord/kanaladgang.

## Det skal du bruge

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installeret
- Fly.io-konto (free tier virker)
- Modelautentificering: Anthropic API-nøgle (eller andre udbydernøgler)
- Kanallegitimationsoplysninger: Discord-bot-token, Telegram-token osv.

## Hurtig vej for begyndere

1. Klon repo → tilpas `fly.toml`
2. Opret app + volume → sæt secrets
3. Udrul med `fly deploy`
4. SSH ind for at oprette konfiguration eller brug Control UI

## 1) Opret Fly-appen

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tip:** Vælg et område tæt på dig. Fælles muligheder: »lhr« (London), »iad« (Virginia), »sjc« (San Jose).

## 2. Konfigurer fly.toml

Redigér `fly.toml` så den matcher dit appnavn og dine krav.

**Sikkerhed note:** Standard config udsætter en offentlig URL. For en hærdet deployering uden offentlig IP, se [Privat Deployment](#private-deployment-hardened) eller brug `fly.private.toml`.

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

**Nøgleindstillinger:**

| Indstilling                    | Hvorfor                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Binder til `0.0.0.0` så Flys proxy kan nå gatewayen                                               |
| `--allow-unconfigured`         | Starter uden en konfigurationsfil (du opretter en senere)                      |
| `internal_port = 3000`         | Skal matche `--port 3000` (eller `OPENCLAW_GATEWAY_PORT`) for Fly-sundhedstjek |
| `memory = "2048mb"`            | 512MB er for lidt; 2GB anbefales                                                                  |
| `OPENCLAW_STATE_DIR = "/data"` | Gør tilstand vedvarende på volumen                                                                |

## 3. Sæt secrets

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

**Noter:**

- Ikke-loopback-bindinger (`--bind lan`) kræver `OPENCLAW_GATEWAY_TOKEN` af sikkerhedshensyn.
- Behandl disse tokens som adgangskoder.
- **Foretræk env vars over config fil** for alle API-nøgler og tokens. Dette holder hemmeligheder ud af `openclaw.json` hvor de ved et uheld kunne blive afsløret eller logget.

## 4. Udrul

```bash
fly deploy
```

Installér først Docker-billedet (~2-3 minutter). Efterfølgende implementeringer er hurtigere.

Efter udrulning, verificér:

```bash
fly status
fly logs
```

Du bør se:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Opret konfigurationsfil

SSH ind på maskinen for at oprette en korrekt konfiguration:

```bash
fly ssh console
```

Opret konfigurationsmappen og filen:

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

**Bemærk:** Med `OPENCLAW_STATE_DIR=/data` er konfigurationsstien `/data/openclaw.json`.

**Bemærk:** Discord-token kan komme fra enten:

- Miljøvariabel: `DISCORD_BOT_TOKEN` (anbefalet til secrets)
- Konfigurationsfil: `channels.discord.token`

Hvis du bruger env var, ingen grund til at tilføje token til config. Gatewayen læser automatisk `DISCORD_BOT_TOKEN`

Genstart for at anvende:

```bash
exit
fly machine restart <machine-id>
```

## 6. Få adgang til Gateway

### Control UI

Åbn i browser:

```bash
fly open
```

Eller besøg `https://my-openclaw.fly.dev/`

Indsæt dit gateway-token (det fra `OPENCLAW_GATEWAY_TOKEN`) for at autentificere.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH-konsol

```bash
fly ssh console
```

## Fejlfinding

### "App is not listening on expected address"

Gatewayen binder til `127.0.0.1` i stedet for `0.0.0.0`.

**Løsning:** Tilføj `--bind lan` til din proceskommando i `fly.toml`.

### Sundhedstjek fejler / forbindelse afvist

Fly kan ikke nå gatewayen på den konfigurerede port.

**Løsning:** Sørg for, at `internal_port` matcher gateway-porten (sæt `--port 3000` eller `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / hukommelsesproblemer

Container fortsætter med at genstarte eller blive dræbt. Tegninger: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, eller tavse genstarter.

**Løsning:** Øg hukommelsen i `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Eller opdatér en eksisterende maskine:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Bemærk:** 512MB er for lille. 1 GB kan fungere, men kan OOM under belastning eller med verbose logning. **2GB anbefales.**

### Gateway-låsproblemer

Gatewayen nægter at starte med fejl som "already running".

Dette sker, når containeren genstarter, men PID-låsfilen bliver liggende på volumen.

**Løsning:** Slet låsfilen:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Låsfilen ligger i `/data/gateway.*.lock` (ikke i en undermappe).

### Konfigurationen bliver ikke læst

Hvis du bruger `-- allow-unconfigured`, opretter gatewayen en minimal konfiguration. Din brugerdefinerede config på `/data / openclaw.json` skal læses ved genstart.

Verificér at konfigurationen findes:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Skrivning af konfiguration via SSH

Kommandoen `fly ssh konsol -C` understøtter ikke skalomdirigering. Sådan skriver du en konfigurationsfil:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Bemærk:** 'flyve sftp' kan mislykkes, hvis filen allerede eksisterer. Slet først:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Tilstand bliver ikke gemt

Hvis du mister legitimationsoplysninger eller sessioner efter en genstart, skriver state-mappen til containerens filsystem.

**Løsning:** Sørg for, at `OPENCLAW_STATE_DIR=/data` er sat i `fly.toml` og udrul igen.

## Opdateringer

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Opdatering af maskinkommando

Hvis du skal ændre opstartskommandoen uden en fuld udrulning:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Bemærk:** Efter `flyve deploy`, maskinens kommando kan nulstille til hvad der er i `fly.toml`. Hvis du har foretaget manuelle ændringer, genanvende dem efter implementering.

## Privat udrulning (hærdet)

Som standard, Fly allokerer offentlige IP'er, hvilket gør din gateway tilgængelig på `https://your-app.fly.dev`. Dette er praktisk, men betyder din implementering er opdaget af internet scannere (Shodan, Censys, etc.).

For en hærdet udrulning **uden offentlig eksponering**, brug den private skabelon.

### Hvornår skal privat udrulning bruges

- Du laver kun **udgående** kald/beskeder (ingen indgående webhooks)
- Du bruger **ngrok- eller Tailscale**-tunneller til webhook-callbacks
- Du tilgår gatewayen via **SSH, proxy eller WireGuard** i stedet for browser
- Du vil have udrulningen **skjult for internet-scannere**

### Opsætning

Brug `fly.private.toml` i stedet for standardkonfigurationen:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Eller konvertér en eksisterende udrulning:

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

Herefter bør `fly ips list` kun vise en IP af typen `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Adgang til en privat udrulning

Da der ikke er nogen offentlig URL, brug en af disse metoder:

**Mulighed 1: Lokal proxy (nemmest)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Mulighed 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Mulighed 3: Kun SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks med privat udrulning

Hvis du har brug for webhook tilbagekald (Twilio, Telnyx, etc.) uden offentlig eksponering:

1. **ngrok-tunnel** – Kør ngrok inde i containeren eller som sidecar
2. **Tailscale Funnel** – Eksponér specifikke stier via Tailscale
3. **Kun udgående** – Nogle udbydere (Twilio) fungerer fint til udgående kald uden webhooks

Eksempel på voice-call-konfiguration med ngrok:

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

Ngrok tunnelen kører inde i beholderen og giver en offentlig webhook URL uden at udsætte flyve app selv. Sæt `webhookSecurity.allowedHosts` til den offentlige tunnel værtsnavn så videresendte vært overskrifter accepteres.

### Sikkerhedsfordele

| Aspekt                | Offentlig   | Privat     |
| --------------------- | ----------- | ---------- |
| Internet-scannere     | Kan opdages | Skjult     |
| Direkte angreb        | Mulige      | Blokeret   |
| Adgang til Control UI | Browser     | Proxy/VPN  |
| Webhook-levering      | Direkte     | Via tunnel |

## Noter

- Fly.io bruger **x86-arkitektur** (ikke ARM)
- Dockerfile er kompatibel med begge arkitekturer
- Til WhatsApp/Telegram-introduktion, brug `fly ssh console`
- Vedvarende data ligger på volumen ved `/data`
- Signal kræver Java + signal-cli; brug et brugerdefineret image og hold hukommelsen på 2GB+.

## Omkostninger

Med den anbefalede konfiguration (`shared-cpu-2x`, 2GB RAM):

- ~$10–15/måned afhængigt af brug
- Free tier inkluderer noget forbrug

Se [Fly.io-priser](https://fly.io/docs/about/pricing/) for detaljer.
