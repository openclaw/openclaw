FROM node:22-bookworm

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

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Expose the gateway port
EXPOSE 18789

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
# Create state directories before switching to node user (supports both legacy and new paths)
RUN mkdir -p /home/node/.clawdbot /home/node/.moltbot \
    && chown -R node:node /home/node/.clawdbot /home/node/.moltbot /home/node

# Create default config for container deployment with reverse proxy support
# - trustedProxies: trust Docker/Podman network ranges for X-Forwarded-For headers  
# - dangerouslyDisableDeviceAuth: required for reverse proxy (browser sends device identity
#   over HTTPS, but gateway can't verify pairing approval without persistent state/manual approval)
# Security note: This disables device-level auth; rely on token/password auth instead
# NOTE: Config must be openclaw.json (not config.yaml) - the code only reads .json files
RUN echo '{"gateway":{"trustedProxies":["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],"controlUi":{"dangerouslyDisableDeviceAuth":true}}}' > /home/node/.moltbot/openclaw.json \
    && chown node:node /home/node/.moltbot/openclaw.json

USER node

# Default: run the gateway server (most common container use case)
# --allow-unconfigured: starts without pre-existing config (configure via Control UI)
# --bind lan: binds to all interfaces (0.0.0.0) for container networking
# IMPORTANT: Set SETUP_PASSWORD env var for web setup wizard, or CLAWDBOT_GATEWAY_TOKEN for direct auth
# Override with: docker run moltbot node dist/index.js <other-command>
CMD ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789", "--allow-unconfigured"]
