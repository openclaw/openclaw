---
summary: "Deploy OpenClaw on a VPS using Coolify"
title: "Coolify (VPS)"
---

# Coolify (VPS)

Deploy OpenClaw on your own VPS using [Coolify](https://coolify.io), an open-source self-hosted PaaS.

## Prerequisites

- A VPS with at least **2 GB RAM** and **20 GB disk**
- Coolify installed on your VPS ([Coolify install guide](https://coolify.io/docs/installation))
- A domain name pointed to your VPS (optional but recommended for HTTPS)

## Quick start

### 1. Add a new resource in Coolify

1. Open your Coolify dashboard
2. Go to **Projects** and select (or create) a project
3. Click **+ New Resource** > **Docker Compose**
4. Choose **Git Repository** as the source and enter:
   - Repository: `https://github.com/openclaw/openclaw`
   - Branch: `main`
   - Docker Compose file: `docker-compose.coolify.yml`

### 2. Configure environment variables

In the Coolify resource settings, go to **Environment Variables** and set:

| Variable | Required | Description |
| --- | --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | Auth token for API access. Generate with `openssl rand -hex 32` |
| `OPENCLAW_CONFIG_DIR` | No | Host path for config (default: Docker volume) |
| `OPENCLAW_WORKSPACE_DIR` | No | Host path for workspace (default: Docker volume) |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `ANTHROPIC_API_KEY` | No | Anthropic API key |
| `GEMINI_API_KEY` | No | Google Gemini key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |

See `.env.coolify.example` in the repo for the full list.

### 3. Configure domain and proxy

In the Coolify resource settings:

1. Go to **General** settings
2. Set your domain (e.g. `openclaw.yourdomain.com`)
3. Coolify auto-configures the reverse proxy (Traefik) with HTTPS via Let's Encrypt
4. Set the exposed port to **18789** (the OpenClaw gateway port)

### 4. Deploy

Click **Deploy**. Coolify will:

1. Clone the repository
2. Build the Docker image from the `Dockerfile`
3. Start the container with your environment variables
4. Set up the reverse proxy and TLS certificate

## Post-deployment

### Access the Control UI

Open `https://openclaw.yourdomain.com/` in your browser. Paste the gateway token in **Settings** to authenticate.

### Health checks

The container includes built-in health checks:

```bash
curl -fsS https://openclaw.yourdomain.com/healthz
curl -fsS https://openclaw.yourdomain.com/readyz
```

### Add channels

Use the Coolify terminal (or SSH into your VPS) to run CLI commands:

```bash
# Enter the container
docker exec -it <container-id> bash

# Add Telegram
openclaw channels add --channel telegram --token "<token>"

# Add Discord
openclaw channels add --channel discord --token "<token>"

# WhatsApp (QR)
openclaw channels login
```

### Using a pre-built image (skip build)

To skip building from source and use the official pre-built image:

1. In Coolify, set the resource source to **Docker Image** instead of Git
2. Use image: `ghcr.io/openclaw/openclaw:latest`
3. Set the Compose file to use `OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest`

Or set `OPENCLAW_IMAGE` in your environment variables if using the Compose file.

## Resource requirements

| Spec | Minimum | Recommended |
| --- | --- | --- |
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 20 GB | 40 GB |

The Docker image build requires at least 2 GB RAM. On low-memory hosts, `pnpm install` may be OOM-killed (exit 137).

## Updating

To update OpenClaw:

1. In Coolify, click **Redeploy** on your resource
2. Coolify pulls the latest code and rebuilds the image

For pre-built images, change the tag or use `latest` to get the newest stable release.

## Troubleshooting

- **Build fails with exit 137**: your VPS does not have enough RAM. Use at least 2 GB, or switch to a pre-built image.
- **Cannot reach the gateway**: verify the port mapping (18789) and that Coolify's proxy is routing to the correct port.
- **Permission errors**: the container runs as `node` (uid 1000). Ensure host-mounted directories are owned by uid 1000: `sudo chown -R 1000:1000 /data/openclaw`.
- **Health check failing**: check container logs in Coolify dashboard or run `docker logs <container-id>`.

## Security notes

- Always set `OPENCLAW_GATEWAY_TOKEN` when exposing the gateway to the internet.
- The gateway binds to `lan` (0.0.0.0) in this configuration since Coolify's reverse proxy needs to reach it.
- Coolify handles TLS termination. Traffic between Coolify's proxy and the container is over the internal Docker network.
- Review [Security hardening](/gateway/security) for additional hardening options.
