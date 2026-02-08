---
summary: "Self-host OpenClaw on your own server with Redis memory and local LLM support"
read_when:
  - Setting up OpenClaw on a local server (Linux or macOS)
  - Configuring LAN access to the web UI
  - Using Redis for persistent memory storage
title: "Self-Hosted"
---

# Self-Hosted Deployment Guide

Deploy OpenClaw on your own server and access the web UI from other machines on your network.

## Supported Platforms

| Platform                  | Status | Notes                    |
| ------------------------- | ------ | ------------------------ |
| Linux (Ubuntu, Debian)    | ✅     | Fully tested             |
| Mac Mini (Intel/M-series) | ✅     | Docker Desktop or Colima |
| Raspberry Pi 4/5          | ✅     | 64-bit OS required       |
| Windows Server            | ⚠️     | WSL2 + Docker Desktop    |

## Prerequisites

### Linux

- Docker Engine 24+ with Docker Compose
- SSH access to the server
- (Optional) Ollama for local LLM inference

### macOS (Mac Mini)

- Docker Desktop or Colima:

  ```bash
  # Option A: Docker Desktop (GUI)
  brew install --cask docker

  # Option B: Colima (CLI-only, lighter)
  brew install colima docker docker-compose
  colima start
  ```

- (Optional) Ollama for local embeddings:
  ```bash
  brew install ollama
  ollama pull nomic-embed-text
  ```

## Quick Start

```bash
# Clone the repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Run the setup script (with Redis memory plugin)
OPENCLAW_MEMORY=redis ./docker-setup.sh
```

The onboarding wizard will guide you through initial configuration.

## Accessing the Web UI over LAN

By default, the Control UI requires HTTPS or localhost access due to browser security restrictions (secure context). When accessing via `http://LAN-IP:port`, browsers cannot use `crypto.subtle` for device identity verification.

### Option 1: Allow Insecure Auth (Recommended for Home Networks)

Edit `~/.openclaw/openclaw.json` and add the `controlUi.allowInsecureAuth` setting:

```json
{
  "gateway": {
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "your-secret-token"
    },
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

Then restart the gateway:

```bash
cd ~/openclaw
docker compose restart openclaw-gateway
```

Access the UI at: `http://SERVER-IP:18789/?token=your-secret-token`

### Option 2: SSH Tunnel (More Secure)

Create an SSH tunnel from your client machine:

```bash
ssh -L 18789:localhost:18789 user@server-ip
```

Then access: `http://localhost:18789/?token=your-token`

This works because `localhost` is always considered a secure context.

### Option 3: HTTPS with Tailscale

Use [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) to expose the gateway over HTTPS.

## Token Configuration

The gateway token can be set in two places. **Both must match** when using Docker:

1. **Config file** (`~/.openclaw/openclaw.json`):

   ```json
   {
     "gateway": {
       "auth": {
         "mode": "token",
         "token": "my-token"
       }
     }
   }
   ```

2. **Docker environment** (`~/openclaw/.env`):
   ```
   OPENCLAW_GATEWAY_TOKEN=my-token
   ```

If these don't match, you'll get `token_mismatch` errors.

## Using Ollama for Local LLM

If you have Ollama running on the same server:

1. Pull the required models:

   ```bash
   ollama pull llama3.2
   ollama pull nomic-embed-text  # For memory/embeddings
   ```

2. Configure OpenClaw to use Ollama. During onboarding, select "OpenAI" as the provider (Ollama is OpenAI-compatible) and set:
   - API Key: `ollama` (any non-empty value)
   - Base URL: `http://SERVER-IP:11434/v1`

   Or edit `~/.openclaw/openclaw.json`:

   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "ollama/llama3.2"
         },
         "models": {
           "ollama/llama3.2": {}
         }
       }
     }
   }
   ```

> **Note on Ollama URL:**
>
> - **Linux:** Use the server's LAN IP (e.g., `http://192.168.1.10:11434/v1`). `host.docker.internal` doesn't work on Linux.
> - **macOS:** Use `http://host.docker.internal:11434/v1` (Docker Desktop resolves this to the host).

## Redis Memory Plugin

To enable persistent memory with Redis:

1. Set the environment variable before running setup:

   ```bash
   export OPENCLAW_MEMORY=redis
   ./docker-setup.sh
   ```

2. Or start Redis manually after setup:

   ```bash
   cd ~/openclaw
   docker compose -f docker-compose.yml -f extensions/memory-redis/docker/docker-compose.yml up -d redis-stack
   ```

3. Configure the plugin in `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "slots": { "memory": "memory-redis" },
       "entries": {
         "memory-redis": {
           "config": {
             "redis": { "url": "redis://redis-stack:6379" },
             "embedding": {
               "provider": "openai",
               "apiKey": "ollama",
               "model": "nomic-embed-text",
               "baseUrl": "http://SERVER-IP:11434/v1"
             },
             "autoRecall": true,
             "autoCapture": true
           }
         }
       }
     }
   }
   ```

## Troubleshooting

### "control ui requires HTTPS or localhost (secure context)"

Add `gateway.controlUi.allowInsecureAuth: true` to your config (see above).

### "token_mismatch" errors

Ensure the token in `~/.openclaw/openclaw.json` matches the `OPENCLAW_GATEWAY_TOKEN` in `~/openclaw/.env`.

### Config changes not taking effect

1. Verify the config inside the container matches your host file:

   ```bash
   docker exec openclaw-openclaw-gateway-1 cat /home/node/.openclaw/openclaw.json
   ```

2. Restart the gateway:
   ```bash
   docker compose restart openclaw-gateway
   ```

### "Config invalid" errors on startup

Run the doctor command to fix schema issues:

```bash
docker exec openclaw-openclaw-gateway-1 openclaw doctor --fix
```

### Two config files exist

If both `openclaw.json` and `openclaw.json5` exist in `~/.openclaw/`, the gateway reads `openclaw.json` first. Either:

- Delete `openclaw.json5` and use `openclaw.json`
- Or ensure your settings are in `openclaw.json`

### Ollama unreachable from container

**On Linux:**

- Use the server's LAN IP, not `localhost`
- Verify Ollama is listening on all interfaces: `OLLAMA_HOST=0.0.0.0 ollama serve`
- Test: `docker exec openclaw-openclaw-gateway-1 curl http://SERVER-IP:11434/api/tags`

**On macOS:**

- Use `host.docker.internal` instead of `localhost`
- Ollama listens on localhost by default, which Docker Desktop can reach
- Test: `docker exec openclaw-openclaw-gateway-1 curl http://host.docker.internal:11434/api/tags`

## Checking Logs

```bash
# Recent gateway logs
docker logs openclaw-openclaw-gateway-1 --since 5m

# Follow logs in real-time
docker logs -f openclaw-openclaw-gateway-1

# Check container status
docker ps | grep openclaw
```
