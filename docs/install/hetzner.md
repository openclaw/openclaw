---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run OpenClaw Gateway 24/7 on a cheap Hetzner VPS (Docker) with durable state and baked-in binaries"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want OpenClaw running 24/7 on a cloud VPS (not your laptop)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a production-grade, always-on Gateway on your own VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want full control over persistence, binaries, and restart behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are running OpenClaw in Docker on Hetzner or a similar provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Hetzner"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on Hetzner (Docker, Production VPS Guide)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a persistent OpenClaw Gateway on a Hetzner VPS using Docker, with durable state, baked-in binaries, and safe restart behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want “OpenClaw 24/7 for ~$5”, this is the simplest reliable setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hetzner pricing changes; pick the smallest Debian/Ubuntu VPS and scale up if you hit OOMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What are we doing (simple terms)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rent a small Linux server (Hetzner VPS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install Docker (isolated app runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start the OpenClaw Gateway in Docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Persist `~/.openclaw` + `~/.openclaw/workspace` on the host (survives restarts/rebuilds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access the Control UI from your laptop via an SSH tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway can be accessed via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH port forwarding from your laptop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct port exposure if you manage firewalling and tokens yourself（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide assumes Ubuntu or Debian on Hetzner.  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are on another Linux VPS, map packages accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the generic Docker flow, see [Docker](/install/docker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick path (experienced operators)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Provision Hetzner VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Install Docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Clone OpenClaw repository（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Create persistent host directories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Configure `.env` and `docker-compose.yml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Bake required binaries into the image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. `docker compose up -d`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Verify persistence and Gateway access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hetzner VPS with root access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH access from your laptop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Basic comfort with SSH + copy/paste（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~20 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker and Docker Compose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional provider credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WhatsApp QR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram bot token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gmail OAuth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Provision the VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create an Ubuntu or Debian VPS in Hetzner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Connect as root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh root@YOUR_VPS_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide assumes the VPS is stateful.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not treat it as disposable infrastructure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Install Docker (on the VPS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
apt-get update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
apt-get install -y git curl ca-certificates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.docker.com | sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Clone the OpenClaw repository（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This guide assumes you will build a custom image to guarantee binary persistence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Create persistent host directories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docker containers are ephemeral.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All long-lived state must live on the host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p /root/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Set ownership to the container user (uid 1000):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
chown -R 1000:1000 /root/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Configure environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `.env` in the repository root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_IMAGE=openclaw:latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_TOKEN=change-me-now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_BIND=lan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_GATEWAY_PORT=18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_DIR=/root/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GOG_KEYRING_PASSWORD=change-me-now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
XDG_CONFIG_HOME=/home/node/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate strong secrets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openssl rand -hex 32（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Do not commit this file.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Docker Compose configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create or update `docker-compose.yml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
services:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw-gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    image: ${OPENCLAW_IMAGE}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    build: .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart: unless-stopped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    env_file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - .env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    environment:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - HOME=/home/node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - NODE_ENV=production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - TERM=xterm-256color（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    volumes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # If you expose this publicly, read /gateway/security and firewall accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      # - "18793:18793"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "dist/index.js",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "gateway",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--bind",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "${OPENCLAW_GATEWAY_BIND}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--port",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "${OPENCLAW_GATEWAY_PORT}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--allow-unconfigured",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--allow-unconfigured` is only for bootstrap convenience, it is not a replacement for a proper gateway configuration. Still set auth (`gateway.auth.token` or password) and use safe bind settings for your deployment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Bake required binaries into the image (critical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Installing binaries inside a running container is a trap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Anything installed at runtime will be lost on restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All external binaries required by skills must be installed at image build time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The examples below show three common binaries only:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog` for Gmail access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `goplaces` for Google Places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wacli` for WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are examples, not a complete list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You may install as many binaries as needed using the same pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you add new skills later that depend on additional binaries, you must:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Update the Dockerfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Rebuild the image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example Dockerfile**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```dockerfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM node:22-bookworm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 1: Gmail CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 2: Google Places CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example binary 3: WhatsApp CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Add more binaries below using the same pattern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WORKDIR /app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY ui/package.json ./ui/package.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY scripts ./scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN corepack enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm install --frozen-lockfile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
COPY . .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RUN pnpm ui:build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ENV NODE_ENV=production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CMD ["node","dist/index.js"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 8) Build and launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose up -d openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify binaries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose exec openclaw-gateway which wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/usr/local/bin/wacli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 9) Verify Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker compose logs -f openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Success:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[gateway] listening on ws://0.0.0.0:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From your laptop:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`http://127.0.0.1:18789/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste your gateway token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What persists where (source of truth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw runs in Docker, but Docker is not the source of truth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All long-lived state must survive restarts, rebuilds, and reboots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Component           | Location                          | Persistence mechanism  | Notes                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | Includes `openclaw.json`, tokens |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount      | OAuth tokens, API keys           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill-level state                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | Code and agent artifacts         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | Preserves QR login               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password | Requires `GOG_KEYRING_PASSWORD`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| External binaries   | `/usr/local/bin/`                 | Docker image           | Must be baked at build time      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Node runtime        | Container filesystem              | Docker image           | Rebuilt every image build        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| OS packages         | Container filesystem              | Docker image           | Do not install at runtime        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Docker container    | Ephemeral                         | Restartable            | Safe to destroy                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
