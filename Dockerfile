FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG CLAWDBOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$CLAWDBOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $CLAWDBOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN CLAWDBOT_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

# Expose the gateway port
EXPOSE 18789

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
# Create the .clawdbot config directory before switching to node user
RUN mkdir -p /home/node/.clawdbot && chown -R node:node /home/node/.clawdbot

# Create default config for container deployment with reverse proxy support
# Trust common Docker/Podman network ranges for X-Forwarded-For headers
RUN echo 'gateway:\n  trustedProxies:\n    - "10.0.0.0/8"\n    - "172.16.0.0/12"\n    - "192.168.0.0/16"' > /home/node/.clawdbot/config.yaml \
    && chown node:node /home/node/.clawdbot/config.yaml

USER node

# Default: run the gateway server (most common container use case)
# --allow-unconfigured: starts without pre-existing config (configure via Control UI)
# --bind lan: binds to all interfaces (0.0.0.0) for container networking
# IMPORTANT: Set CLAWDBOT_GATEWAY_TOKEN env var for auth when using --bind lan
# Override with: docker run moltbot node dist/index.js <other-command>
CMD ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789", "--allow-unconfigured"]
