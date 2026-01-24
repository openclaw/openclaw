---
title: Fly.io
description: Deploy Clawdbot on Fly.io
---

# Fly.io Deployment

**Goal:** Clawdbot Gateway running on a [Fly.io](https://fly.io) machine with persistent storage, automatic HTTPS, and Discord/channel access.

## What you need

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account (free tier works)
- Model auth: Anthropic API key (or other provider keys)
- Channel credentials: Discord bot token, Telegram token, etc.

## Beginner quick path

1. Clone repo → customize `fly.toml`
2. Create app + volume → set secrets
3. Deploy with `fly deploy`
4. SSH in to create config or use Control UI

## 1) Create the Fly app

```bash
# Clone the repo
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot

# Create a new Fly app (pick your own name)
fly apps create my-clawdbot

# Create a persistent volume (1GB is usually enough)
fly volumes create clawdbot_data --size 1 --region lhr
```

**Tip:** Choose a region close to you. Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2) Configure fly.toml

Edit `fly.toml` to match your app name and requirements:

```toml
app = "my-clawdbot"  # Your app name
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  CLAWDBOT_PREFER_PNPM = "1"
  CLAWDBOT_STATE_DIR = "/data"
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
  source = "clawdbot_data"
  destination = "/data"
```

**Key settings:**

| Setting | Why |
|---------|-----|
| `--bind lan` | Binds to `0.0.0.0` so Fly's proxy can reach the gateway |
| `--allow-unconfigured` | Starts without a config file (you'll create one after) |
| `memory = "2048mb"` | 512MB is too small; 2GB recommended |
| `CLAWDBOT_STATE_DIR = "/data"` | Persists state on the volume |

## 3) Set secrets

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set CLAWDBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Notes:**
- Non-loopback binds (`--bind lan`) require `CLAWDBOT_GATEWAY_TOKEN` for security.
- Treat these tokens like passwords.

## 4) Deploy

```bash
fly deploy
```

First deploy builds the Docker image (~2-3 minutes). Subsequent deploys are faster.

After deployment, verify:
```bash
fly status
fly logs
```

You should see:
```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5) Create config file

SSH into the machine to create a proper config:

```bash
fly ssh console
```

Create the config directory and file:
```bash
mkdir -p /data/.clawdbot
cat > /data/.clawdbot/clawdbot.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5"
      },
      "models": {
        "anthropic/claude-opus-4-5": {},
        "anthropic/claude-sonnet-4-5": {}
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
  "channels": {
    "discord": {
      "enabled": true
    }
  }
}
EOF
```

Restart to apply:
```bash
exit
fly machine restart <machine-id>
```

## 6) Access the Gateway

### Control UI

Open in browser:
```bash
fly open
```

Or visit `https://my-clawdbot.fly.dev/`

Paste your gateway token (the one from `CLAWDBOT_GATEWAY_TOKEN`) to authenticate.

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

The gateway is binding to `127.0.0.1` instead of `0.0.0.0`.

**Fix:** Add `--bind lan` to your process command in `fly.toml`.

### OOM / Memory Issues

Container keeps restarting or getting killed.

**Fix:** Increase memory in `fly.toml`:
```toml
[[vm]]
  memory = "2048mb"
```

### Gateway Lock Issues

Gateway refuses to start with "already running" errors.

This happens when the container restarts but the PID lock file persists on the volume.

**Fix:** Delete the lock file:
```bash
fly ssh console
rm /data/.clawdbot/run/gateway.*.lock
exit
fly machine restart <machine-id>
```

### Config Not Being Read

If using `--allow-unconfigured`, the gateway creates a minimal config. Your custom config at `/data/.clawdbot/clawdbot.json` should be read on restart.

Verify the config exists:
```bash
fly ssh console --command "cat /data/.clawdbot/clawdbot.json"
```

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

## Notes

- Fly.io uses **x86 architecture** (not ARM)
- The Dockerfile is compatible with both architectures
- For WhatsApp/Telegram onboarding, use `fly ssh console`
- Persistent data lives on the volume at `/data`

## Cost

With the recommended config (`shared-cpu-2x`, 2GB RAM):
- ~$10-15/month depending on usage
- Free tier includes some allowance

See [Fly.io pricing](https://fly.io/docs/about/pricing/) for details.
