# OpenClaw on Hetzner VPS - Complete Setup Guide

This document captures all the challenges, solutions, and hardening steps required to successfully run OpenClaw in Docker on a Hetzner VPS with Homebrew support.

## Overview

This guide covers the complete journey from a fresh Hetzner VPS to a production-ready, secure OpenClaw Gateway installation with Homebrew package management support.

## Prerequisites

- Hetzner VPS (Ubuntu/Debian)
- Root access
- Docker and Docker Compose installed

## The Journey

### Phase 1: Initial Setup

#### 1. Install Docker

```bash
apt-get update && apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

#### 2. Clone OpenClaw Repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

#### 3. Create Persistent Directories

Docker containers are ephemeral. All long-lived state must live on the host:

```bash
mkdir -p /root/.openclaw/workspace
chown -R 1000:1000 /root/.openclaw
```

#### 4. Configure Environment Variables

Create `.env` file:

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=$(openssl rand -hex 32)
XDG_CONFIG_HOME=/home/node/.openclaw

# Suppress Docker Compose warnings for optional variables
CLAUDE_AI_SESSION_KEY=
CLAUDE_WEB_SESSION_KEY=
CLAUDE_WEB_COOKIE=
```

### Phase 2: Dockerfile Challenges & Solutions

#### Challenge 1: Homebrew Installation in Docker

**Problem**: Homebrew refuses to install as root (Docker default user).

**Error**:
```
Don't run this as root!
```

**Solution**: Use a multi-stage build with a non-root user for Homebrew installation:

```dockerfile
FROM node:22-bookworm as homebrew-builder

# Install dependencies
RUN apt-get update && apt-get install -y curl git file && rm -rf /var/lib/apt/lists/*

# Create linuxbrew user for Homebrew installation
RUN useradd -m -s /bin/bash linuxbrew && \
    mkdir -p /home/linuxbrew/.linuxbrew && \
    chown -R linuxbrew:linuxbrew /home/linuxbrew

# Install Homebrew as linuxbrew user
USER linuxbrew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install packages via Homebrew
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
RUN eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    brew tap steipete/tap && \
    brew install gogcli goplaces

# Final stage
FROM node:22-bookworm

# Copy entire Homebrew installation
COPY --from=homebrew-builder /home/linuxbrew/.linuxbrew /home/linuxbrew/.linuxbrew
```

#### Challenge 2: Incorrect Binary URLs in Documentation

**Problem**: Original documentation had wrong URLs for binary downloads.

**Issues Found**:
1. `gog` repository is `steipete/gogcli`, not `steipete/gog` (404 error)
2. `latest/download` URL pattern doesn't work for these repositories
3. `wacli` only provides macOS binaries, no Linux support

**Solution**: Use versioned URLs and install via Homebrew:

```dockerfile
# gogcli: v0.11.0 - Gmail CLI
# goplaces: v0.3.0 - Google Places CLI
# wacli: Removed - macOS only

RUN eval "$(brew shellenv)" && \
    brew tap steipete/tap && \
    brew install gogcli goplaces
```

#### Challenge 3: npm Permission Issues

**Problem**: OpenClaw runs as `node` user (uid 1000), but npm tries to install to `/usr/local/lib/node_modules` (owned by root).

**Error**:
```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/clawhub
npm error errno -13
```

**Solution**: Configure npm to use user directory and update PATH:

```dockerfile
# Configure npm for node user
RUN mkdir -p /home/node/.npm-global && \
    chown -R node:node /home/node/.npm-global

USER node

# Set npm to use user directory for global installs
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH
```

#### Challenge 4: Homebrew Permissions for Runtime

**Problem**: After switching to `node` user, Homebrew directories are owned by root.

**Error**:
```
Error: The following directories are not writable by your user:
/home/linuxbrew/.linuxbrew/Cellar
/home/linuxbrew/.linuxbrew/bin
...
```

**Solution**: Change ownership before switching to node user:

```dockerfile
# Change ownership of Homebrew directories to node user
RUN chown -R node:node /home/linuxbrew/.linuxbrew /app /usr/local/lib/node_modules 2>/dev/null || true

USER node
```

### Phase 3: Security Hardening

#### 1. Firewall Configuration (UFW)

```bash
apt-get install -y ufw fail2ban
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 41641/udp   # Tailscale (optional)
echo "y" | ufw enable
```

#### 2. Docker Port Binding (Critical!)

**⚠️ Security Risk**: Never expose OpenClaw ports to 0.0.0.0

**Wrong** (exposes to internet):
```yaml
ports:
  - "18789:18789"
  - "18790:18790"
```

**Correct** (localhost only):
```yaml
ports:
  - "127.0.0.1:18789:18789"
  - "127.0.0.1:18790:18790"
```

#### 3. File Permissions

```bash
chmod 600 /root/.openclaw/.env
chmod 600 /root/openclaw/.env
chmod 700 /root/.openclaw
chmod 600 /root/.openclaw/openclaw.json
```

#### 4. OpenClaw Security Configuration

Secure `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace"
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "your-long-random-token-here"
    }
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "tools": {
    "profile": "messaging",
    "deny": ["group:automation", "group:runtime", "group:fs"],
    "fs": {
      "workspaceOnly": true
    },
    "exec": {
      "security": "deny",
      "ask": "always"
    },
    "elevated": {
      "enabled": false
    }
  }
}
```

#### 5. Docker Compose Security

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE:-openclaw:latest}
    build: .
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      NPM_CONFIG_PREFIX: /home/node/.npm-global
      PATH: /home/node/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # SECURITY: Bind only to localhost - access via SSH tunnel
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
      - "127.0.0.1:${OPENCLAW_BRIDGE_PORT}:18790"
    init: true
    restart: unless-stopped
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND:-lan}",
        "--port",
        "18789",
        "--allow-unconfigured",
      ]
```

### Phase 4: Complete Working Dockerfile

```dockerfile
FROM node:22-bookworm as homebrew-builder

# Install dependencies
RUN apt-get update && apt-get install -y curl git file && rm -rf /var/lib/apt/lists/*

# Create linuxbrew user for Homebrew installation
RUN useradd -m -s /bin/bash linuxbrew && \
    mkdir -p /home/linuxbrew/.linuxbrew && \
    chown -R linuxbrew:linuxbrew /home/linuxbrew

# Install Homebrew as linuxbrew user
USER linuxbrew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install gogcli and goplaces via Homebrew
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
RUN eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    brew tap steipete/tap && \
    brew install gogcli goplaces

# Verify binaries work
RUN eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    gog --version && \
    goplaces --version

USER root

# Final stage
FROM node:22-bookworm

# Copy entire Homebrew installation
COPY --from=homebrew-builder /home/linuxbrew/.linuxbrew /home/linuxbrew/.linuxbrew

# Install runtime dependencies
RUN apt-get update && apt-get install -y socat git file && rm -rf /var/lib/apt/lists/*

# Set up Homebrew environment
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_NO_AUTO_UPDATE=1
ENV HOMEBREW_NO_ANALYTICS=1

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY . .
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Configure npm for node user (install packages to user directory, not system)
RUN mkdir -p /home/node/.npm-global && \
    chown -R node:node /home/node/.npm-global

# Change ownership of Homebrew directories to node user for runtime installs
RUN chown -R node:node /home/linuxbrew/.linuxbrew /app /usr/local/lib/node_modules 2>/dev/null || true

USER node

# Set npm to use user directory for global installs
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
```

### Phase 5: Accessing the Gateway

#### Method 1: SSH Tunnel (Recommended - Most Secure)

From your local machine:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Then open in browser:
```
http://127.0.0.1:18789/
```

Enter the gateway token from your `.env` file when prompted.

#### Method 2: Using the CLI Alias

Add to `~/.bashrc`:

```bash
alias openclaw='docker compose -f /root/openclaw/docker-compose.yml exec openclaw-gateway node dist/index.js'
```

Then source it:
```bash
source ~/.bashrc
openclaw status
```

### Phase 6: Maintenance & Operations

#### Updating the Gateway

```bash
cd /root/openclaw
docker compose down
docker compose build --no-cache
docker compose up -d openclaw-gateway
```

#### Installing Additional Homebrew Packages

```bash
# At runtime
docker compose exec openclaw-gateway bash -c 'eval "$(brew shellenv)" && brew install <package>'

# Or add to Dockerfile and rebuild
RUN eval "$(brew shellenv)" && brew install <package>
```

#### Installing Additional npm Packages

```bash
# At runtime (already configured to use user directory)
docker compose exec openclaw-gateway npm install -g <package>
```

#### Security Audit

```bash
openclaw security audit
openclaw security audit --deep
```

## Key Lessons Learned

### 1. Homebrew in Docker is Complex
- Homebrew refuses to run as root
- Requires multi-stage build with non-root user
- Runtime permissions must be fixed for the `node` user

### 2. npm Permissions Require Configuration
- Default npm prefix is system directory (owned by root)
- Must configure `NPM_CONFIG_PREFIX` for user directory
- PATH must include user npm bin directory

### 3. Security is Multi-Layered
- Firewall (UFW) blocks external access
- Docker port binding restricts to localhost
- OpenClaw config enforces authentication and safe defaults
- File permissions protect sensitive data

### 4. Documentation URLs May Be Outdated
- `latest/download` pattern doesn't work for all GitHub repos
- Some tools (like `wacli`) don't support Linux
- Always verify actual binary availability

## Troubleshooting

### Container keeps restarting
Check logs:
```bash
docker compose logs openclaw-gateway
```

Common causes:
- Invalid config syntax in `openclaw.json`
- Permission issues on volumes

### Cannot install npm packages
Verify npm config:
```bash
docker compose exec openclaw-gateway npm config get prefix
# Should show: /home/node/.npm-global
```

### Cannot use Homebrew
Verify permissions:
```bash
docker compose exec openclaw-gateway bash -c 'eval "$(brew shellenv)" && brew --version'
```

### Port already in use
```bash
# Find and kill process
lsof -ti:18789 | xargs kill -9
# Or use different port in .env
```

## Security Checklist

Before considering this production-ready:

- [ ] UFW firewall enabled with only SSH exposed
- [ ] OpenClaw ports bound to 127.0.0.1 (not 0.0.0.0)
- [ ] Strong random token in `OPENCLAW_GATEWAY_TOKEN`
- [ ] File permissions set to 600 for configs
- [ ] Gateway auth enabled with token mode
- [ ] DM scope set to `per-channel-peer`
- [ ] Tools profile set to `messaging` or more restrictive
- [ ] Elevated tools disabled
- [ ] Access only via SSH tunnel or VPN
- [ ] Fail2ban installed and running
- [ ] Regular security audits scheduled

## References

- OpenClaw Documentation: https://docs.openclaw.ai/
- Hetzner Guide: https://docs.openclaw.ai/install/hetzner
- Security Guide: https://docs.openclaw.ai/gateway/security
- GitHub Repository: https://github.com/openclaw/openclaw

## Contributing

If you encounter issues or improvements, consider contributing to the OpenClaw documentation:
- Update binary URLs if they change
- Add new Homebrew-compatible tools
- Share security hardening improvements

---

**Document Version**: 2026.02.18  
**Tested On**: Ubuntu 24.04 LTS on Hetzner VPS  
**OpenClaw Version**: 2026.2.18
