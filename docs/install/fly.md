---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Fly.io（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Deploy OpenClaw on Fly.io（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Fly.io Deployment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Goal:** OpenClaw Gateway running on a [Fly.io](https://fly.io) machine with persistent storage, automatic HTTPS, and Discord/channel access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fly.io account (free tier works)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth: Anthropic API key (or other provider keys)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel credentials: Discord bot token, Telegram token, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner quick path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Clone repo → customize `fly.toml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create app + volume → set secrets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Deploy with `fly deploy`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. SSH in to create config or use Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Create the Fly app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clone the repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create a new Fly app (pick your own name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly apps create my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create a persistent volume (1GB is usually enough)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly volumes create openclaw_data --size 1 --region iad（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Tip:** Choose a region close to you. Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Configure fly.toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit `fly.toml` to match your app name and requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Security note:** The default config exposes a public URL. For a hardened deployment with no public IP, see [Private Deployment](#private-deployment-hardened) or use `fly.private.toml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
app = "my-openclaw"  # Your app name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
primary_region = "iad"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[build]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dockerfile = "Dockerfile"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[env]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NODE_ENV = "production"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OPENCLAW_PREFER_PNPM = "1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OPENCLAW_STATE_DIR = "/data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NODE_OPTIONS = "--max-old-space-size=1536"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[processes]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[http_service]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  internal_port = 3000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  force_https = true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auto_stop_machines = false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auto_start_machines = true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  min_machines_running = 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  processes = ["app"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[[vm]]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  size = "shared-cpu-2x"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  memory = "2048mb"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[mounts]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source = "openclaw_data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  destination = "/data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key settings:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Setting                        | Why                                                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------ | --------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--bind lan`                   | Binds to `0.0.0.0` so Fly's proxy can reach the gateway                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--allow-unconfigured`         | Starts without a config file (you'll create one after)                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `internal_port = 3000`         | Must match `--port 3000` (or `OPENCLAW_GATEWAY_PORT`) for Fly health checks |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `memory = "2048mb"`            | 512MB is too small; 2GB recommended                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_STATE_DIR = "/data"` | Persists state on the volume                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Set secrets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Required: Gateway token (for non-loopback binding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model provider API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly secrets set ANTHROPIC_API_KEY=sk-ant-...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional: Other providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly secrets set OPENAI_API_KEY=sk-...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly secrets set GOOGLE_API_KEY=...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Channel tokens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly secrets set DISCORD_BOT_TOKEN=MTQ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Notes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-loopback binds (`--bind lan`) require `OPENCLAW_GATEWAY_TOKEN` for security.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat these tokens like passwords.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Prefer env vars over config file** for all API keys and tokens. This keeps secrets out of `openclaw.json` where they could be accidentally exposed or logged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Deploy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly deploy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
First deploy builds the Docker image (~2-3 minutes). Subsequent deploys are faster.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After deployment, verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You should see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[discord] logged in to discord as xxx（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Create config file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SSH into the machine to create a proper config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create the config directory and file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p /data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat > /data/openclaw.json << 'EOF'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "model": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primary": "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "maxConcurrent": 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "default": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "auth": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "profiles": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic:default": { "mode": "token", "provider": "anthropic" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "openai:default": { "mode": "token", "provider": "openai" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "bindings": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "agentId": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "match": { "channel": "discord" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "discord": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "groupPolicy": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "guilds": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "YOUR_GUILD_ID": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "channels": { "general": { "allow": true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "requireMention": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "gateway": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "mode": "local",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "bind": "auto"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "meta": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "lastTouchedVersion": "2026.1.29"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** With `OPENCLAW_STATE_DIR=/data`, the config path is `/data/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** The Discord token can come from either:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variable: `DISCORD_BOT_TOKEN` (recommended for secrets)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config file: `channels.discord.token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If using env var, no need to add token to config. The gateway reads `DISCORD_BOT_TOKEN` automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart to apply:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machine restart <machine-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Access the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open in browser:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly open（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or visit `https://my-openclaw.fly.dev/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste your gateway token (the one from `OPENCLAW_GATEWAY_TOKEN`) to authenticate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly logs              # Live logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly logs --no-tail    # Recent logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### SSH Console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### "App is not listening on expected address"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway is binding to `127.0.0.1` instead of `0.0.0.0`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Add `--bind lan` to your process command in `fly.toml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Health checks failing / connection refused（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fly can't reach the gateway on the configured port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Ensure `internal_port` matches the gateway port (set `--port 3000` or `OPENCLAW_GATEWAY_PORT=3000`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OOM / Memory Issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Container keeps restarting or getting killed. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Increase memory in `fly.toml`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[[vm]]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  memory = "2048mb"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or update an existing machine:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machine update <machine-id> --vm-memory 2048 -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** 512MB is too small. 1GB may work but can OOM under load or with verbose logging. **2GB is recommended.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway Lock Issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway refuses to start with "already running" errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This happens when the container restarts but the PID lock file persists on the volume.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Delete the lock file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console --command "rm -f /data/gateway.*.lock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machine restart <machine-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The lock file is at `/data/gateway.*.lock` (not in a subdirectory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config Not Being Read（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If using `--allow-unconfigured`, the gateway creates a minimal config. Your custom config at `/data/openclaw.json` should be read on restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify the config exists:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console --command "cat /data/openclaw.json"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Writing Config via SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `fly ssh console -C` command doesn't support shell redirection. To write a config file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Use echo + tee (pipe from local to remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or use sftp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly sftp shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> put /local/path/config.json /data/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** `fly sftp` may fail if the file already exists. Delete first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console --command "rm /data/openclaw.json"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### State Not Persisting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you lose credentials or sessions after a restart, the state dir is writing to the container filesystem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix:** Ensure `OPENCLAW_STATE_DIR=/data` is set in `fly.toml` and redeploy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pull latest changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git pull（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Redeploy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly deploy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Updating Machine Command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need to change the startup command without a full redeploy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Get machine ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machines list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or with memory increase（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** After `fly deploy`, the machine command may reset to what's in `fly.toml`. If you made manual changes, re-apply them after deploy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Private Deployment (Hardened)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, Fly allocates public IPs, making your gateway accessible at `https://your-app.fly.dev`. This is convenient but means your deployment is discoverable by internet scanners (Shodan, Censys, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a hardened deployment with **no public exposure**, use the private template.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### When to use private deployment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You only make **outbound** calls/messages (no inbound webhooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You use **ngrok or Tailscale** tunnels for any webhook callbacks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You access the gateway via **SSH, proxy, or WireGuard** instead of browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You want the deployment **hidden from internet scanners**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `fly.private.toml` instead of the standard config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Deploy with private config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly deploy -c fly.private.toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or convert an existing deployment:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# List current IPs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ips list -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Release public IPs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ips release <public-ipv4> -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ips release <public-ipv6> -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Switch to private config so future deploys don't re-allocate public IPs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# (remove [http_service] or deploy with the private template)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly deploy -c fly.private.toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Allocate private-only IPv6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ips allocate-v6 --private -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After this, `fly ips list` should show only a `private` type IP:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VERSION  IP                   TYPE             REGION（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
v6       fdaa:x:x:x:x::x      private          global（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Accessing a private deployment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Since there's no public URL, use one of these methods:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option 1: Local proxy (simplest)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Forward local port 3000 to the app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly proxy 3000:3000 -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Then open http://localhost:3000 in browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option 2: WireGuard VPN**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Create WireGuard config (one-time)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly wireguard create（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Import to WireGuard client, then access via internal IPv6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example: http://[fdaa:x:x:x:x::x]:3000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option 3: SSH only**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fly ssh console -a my-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Webhooks with private deployment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need webhook callbacks (Twilio, Telnyx, etc.) without public exposure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **ngrok tunnel** - Run ngrok inside the container or as a sidecar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Tailscale Funnel** - Expose specific paths via Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Outbound-only** - Some providers (Twilio) work fine for outbound calls without webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example voice-call config with ngrok:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "plugins": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "config": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "provider": "twilio",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "tunnel": { "provider": "ngrok" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "webhookSecurity": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "allowedHosts": ["example.ngrok.app"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The ngrok tunnel runs inside the container and provides a public webhook URL without exposing the Fly app itself. Set `webhookSecurity.allowedHosts` to the public tunnel hostname so forwarded host headers are accepted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Security benefits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect            | Public       | Private    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ------------ | ---------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Internet scanners | Discoverable | Hidden     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Direct attacks    | Possible     | Blocked    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Control UI access | Browser      | Proxy/VPN  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Webhook delivery  | Direct       | Via tunnel |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fly.io uses **x86 architecture** (not ARM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Dockerfile is compatible with both architectures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For WhatsApp/Telegram onboarding, use `fly ssh console`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Persistent data lives on the volume at `/data`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal requires Java + signal-cli; use a custom image and keep memory at 2GB+.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With the recommended config (`shared-cpu-2x`, 2GB RAM):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~$10-15/month depending on usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Free tier includes some allowance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Fly.io pricing](https://fly.io/docs/about/pricing/) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
