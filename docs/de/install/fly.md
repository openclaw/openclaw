---
title: Fly.io
description: OpenClaw auf Fly.io bereitstellen
---

# Fly.io-Bereitstellung

**Ziel:** OpenClaw Gateway auf einer [Fly.io](https://fly.io)-Maschine mit persistentem Speicher, automatischem HTTPS und Discord-/Kanal-Zugriff.

## Was Sie benötigen

- Installierte [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io-Konto (Free-Tier reicht aus)
- Modell-Authentifizierung: Anthropic-API-Schlüssel (oder andere Anbieter-Schlüssel)
- Kanal-Zugangsdaten: Discord-Bot-Token, Telegram-Token usw.

## Schneller Einstieg für Anfänger

1. Repository klonen → `fly.toml` anpassen
2. App + Volume erstellen → Secrets setzen
3. Mit `fly deploy` deployen
4. Per SSH anmelden, um Konfiguration zu erstellen, oder Control UI verwenden

## 1) Fly-App erstellen

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Tipp:** Wählen Sie eine Region in Ihrer Nähe. Häufige Optionen: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2. fly.toml konfigurieren

Bearbeiten Sie `fly.toml`, damit es zu Ihrem App-Namen und Ihren Anforderungen passt.

**Sicherheitshinweis:** Die Standardkonfiguration stellt eine öffentliche URL bereit. Für eine gehärtete Bereitstellung ohne öffentliche IP siehe [Private Deployment](#private-deployment-hardened) oder verwenden Sie `fly.private.toml`.

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

**Zentrale Einstellungen:**

| Einstellung                    | Warum                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Bindet an `0.0.0.0`, damit der Fly-Proxy das Gateway erreichen kann                                           |
| `--allow-unconfigured`         | Startet ohne Konfigurationsdatei (Sie erstellen diese später)                              |
| `internal_port = 3000`         | Muss mit `--port 3000` (oder `OPENCLAW_GATEWAY_PORT`) für Fly-Health-Checks übereinstimmen |
| `memory = "2048mb"`            | 512 MB sind zu wenig; 2 GB empfohlen                                                                          |
| `OPENCLAW_STATE_DIR = "/data"` | Persistiert den Zustand auf dem Volume                                                                        |

## 3. Secrets setzen

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

**Hinweise:**

- Nicht-Loopback-Bindings (`--bind lan`) erfordern aus Sicherheitsgründen `OPENCLAW_GATEWAY_TOKEN`.
- Behandeln Sie diese Tokens wie Passwörter.
- **Bevorzugen Sie Umgebungsvariablen gegenüber der Konfigurationsdatei** für alle API-Schlüssel und Tokens. So bleiben Secrets aus `openclaw.json` heraus, wo sie versehentlich offengelegt oder geloggt werden könnten.

## 4. Deploy

```bash
fly deploy
```

Der erste Deploy baut das Docker-Image (~2–3 Minuten). Nachfolgende Deploys sind schneller.

Nach der Bereitstellung prüfen Sie:

```bash
fly status
fly logs
```

Sie sollten Folgendes sehen:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Konfigurationsdatei erstellen

Melden Sie sich per SSH an der Maschine an, um eine vollständige Konfiguration zu erstellen:

```bash
fly ssh console
```

Erstellen Sie das Konfigurationsverzeichnis und die Datei:

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

**Hinweis:** Mit `OPENCLAW_STATE_DIR=/data` ist der Konfigurationspfad `/data/openclaw.json`.

**Hinweis:** Das Discord-Token kann aus einer der folgenden Quellen stammen:

- Umgebungsvariable: `DISCORD_BOT_TOKEN` (empfohlen für Secrets)
- Konfigurationsdatei: `channels.discord.token`

Wenn Sie die Umgebungsvariable verwenden, müssen Sie das Token nicht in die Konfiguration aufnehmen. Das Gateway liest `DISCORD_BOT_TOKEN` automatisch.

Zum Anwenden neu starten:

```bash
exit
fly machine restart <machine-id>
```

## 6. Zugriff auf das Gateway

### Control UI

Im Browser öffnen:

```bash
fly open
```

Oder besuchen Sie `https://my-openclaw.fly.dev/`

Fügen Sie Ihr Gateway-Token (das aus `OPENCLAW_GATEWAY_TOKEN`) zur Authentifizierung ein.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH-Konsole

```bash
fly ssh console
```

## Fehlerbehebung

### „App is not listening on expected address“

Das Gateway bindet an `127.0.0.1` statt an `0.0.0.0`.

**Behebung:** Fügen Sie `--bind lan` zum Prozessbefehl in `fly.toml` hinzu.

### Health-Checks schlagen fehl / Verbindung abgelehnt

Fly kann das Gateway auf dem konfigurierten Port nicht erreichen.

**Behebung:** Stellen Sie sicher, dass `internal_port` mit dem Gateway-Port übereinstimmt (setzen Sie `--port 3000` oder `OPENCLAW_GATEWAY_PORT=3000`).

### OOM- / Speicherprobleme

Der Container startet ständig neu oder wird beendet. Anzeichen: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` oder stille Neustarts.

**Behebung:** Erhöhen Sie den Speicher in `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Oder aktualisieren Sie eine bestehende Maschine:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Hinweis:** 512 MB sind zu wenig. 1 GB kann funktionieren, aber unter Last oder mit ausführlichem Logging zu OOM führen. **2 GB werden empfohlen.**

### Gateway-Lock-Probleme

Das Gateway startet nicht und meldet „already running“-Fehler.

Dies passiert, wenn der Container neu startet, aber die PID-Lockdatei auf dem Volume bestehen bleibt.

**Behebung:** Löschen Sie die Lockdatei:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Die Lockdatei befindet sich unter `/data/gateway.*.lock` (nicht in einem Unterverzeichnis).

### Konfiguration wird nicht gelesen

Bei Verwendung von `--allow-unconfigured` erstellt das Gateway eine minimale Konfiguration. Ihre benutzerdefinierte Konfiguration unter `/data/openclaw.json` sollte nach einem Neustart gelesen werden.

Prüfen Sie, ob die Konfiguration existiert:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Konfiguration per SSH schreiben

Der Befehl `fly ssh console -C` unterstützt keine Shell-Umleitung. Um eine Konfigurationsdatei zu schreiben:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Hinweis:** `fly sftp` kann fehlschlagen, wenn die Datei bereits existiert. Löschen Sie sie zuerst:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Zustand wird nicht persistiert

Wenn nach einem Neustart Zugangsdaten oder Sitzungen verloren gehen, schreibt das Zustandsverzeichnis in das Container-Dateisystem.

**Behebung:** Stellen Sie sicher, dass `OPENCLAW_STATE_DIR=/data` in `fly.toml` gesetzt ist, und deployen Sie erneut.

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

### Maschinenbefehl aktualisieren

Wenn Sie den Startbefehl ändern müssen, ohne einen vollständigen Redeploy durchzuführen:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Hinweis:** Nach `fly deploy` kann der Maschinenbefehl auf den Wert in `fly.toml` zurückgesetzt werden. Wenn Sie manuelle Änderungen vorgenommen haben, wenden Sie diese nach dem Deploy erneut an.

## Private Bereitstellung (gehärtet)

Standardmäßig weist Fly öffentliche IPs zu, wodurch Ihr Gateway unter `https://your-app.fly.dev` erreichbar ist. Das ist bequem, bedeutet aber, dass Ihre Bereitstellung für Internet-Scanner (Shodan, Censys usw.) auffindbar ist.

Für eine gehärtete Bereitstellung **ohne öffentliche Exponierung** verwenden Sie das private Template.

### Wann eine private Bereitstellung sinnvoll ist

- Sie tätigen nur **ausgehende** Aufrufe/Nachrichten (keine eingehenden Webhooks)
- Sie nutzen **ngrok- oder Tailscale**-Tunnel für Webhook-Callbacks
- Sie greifen über **SSH, Proxy oder WireGuard** statt über den Browser auf das Gateway zu
- Sie möchten die Bereitstellung **vor Internet-Scannern verbergen**

### Einrichtung

Verwenden Sie `fly.private.toml` statt der Standardkonfiguration:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Oder konvertieren Sie eine bestehende Bereitstellung:

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

Danach sollte `fly ips list` nur eine IP vom Typ `private` anzeigen:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Zugriff auf eine private Bereitstellung

Da es keine öffentliche URL gibt, verwenden Sie eine der folgenden Methoden:

**Option 1: Lokaler Proxy (am einfachsten)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Option 2: WireGuard-VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Option 3: Nur SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooks mit privater Bereitstellung

Wenn Sie Webhook-Callbacks (Twilio, Telnyx usw.) ohne öffentliche Exponierung benötigen:

1. **ngrok-Tunnel** – ngrok innerhalb des Containers oder als Sidecar ausführen
2. **Tailscale Funnel** – Bestimmte Pfade über Tailscale freigeben
3. **Nur ausgehend** – Einige Anbieter (Twilio) funktionieren für ausgehende Anrufe auch ohne Webhooks

Beispiel für eine Sprachruf-Konfiguration mit ngrok:

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

Der ngrok-Tunnel läuft innerhalb des Containers und stellt eine öffentliche Webhook-URL bereit, ohne die Fly-App selbst offenzulegen. Setzen Sie `webhookSecurity.allowedHosts` auf den öffentlichen Tunnel-Hostname, damit weitergeleitete Host-Header akzeptiert werden.

### Sicherheitsvorteile

| Aspekt             | Öffentlich | Privat      |
| ------------------ | ---------- | ----------- |
| Internet-Scanner   | Auffindbar | Versteckt   |
| Direkte Angriffe   | Möglich    | Blockiert   |
| Control-UI-Zugriff | Browser    | Proxy/VPN   |
| Webhook-Zustellung | Direkt     | Über Tunnel |

## Hinweise

- Fly.io verwendet eine **x86-Architektur** (nicht ARM)
- Das Dockerfile ist mit beiden Architekturen kompatibel
- Für WhatsApp-/Telegram-Onboarding verwenden Sie `fly ssh console`
- Persistente Daten liegen auf dem Volume unter `/data`
- Signal erfordert Java + signal-cli; verwenden Sie ein benutzerdefiniertes Image und halten Sie den Speicher bei 2 GB+.

## Kosten

Mit der empfohlenen Konfiguration (`shared-cpu-2x`, 2 GB RAM):

- ~10–15 USD/Monat je nach Nutzung
- Das Free-Tier enthält ein gewisses Kontingent

Details finden Sie unter [Fly.io pricing](https://fly.io/docs/about/pricing/).
