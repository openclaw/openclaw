FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Install Tailscale, gosu, and Brave browser with headless dependencies
RUN curl -fsSL https://tailscale.com/install.sh | sh && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    gosu \
    curl \
    nano \
    apt-transport-https \
    ca-certificates \
    gnupg && \
    curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=amd64] https://brave-browser-apt-release.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-release.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    brave-browser \
    fonts-liberation \
    fonts-noto-color-emoji \
    # Additional libraries for headless browser operation
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libxss1 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install summarize via npm (much simpler than Homebrew)
RUN npm install -g @steipete/summarize

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

# Install openclaw CLI globally so it's available as a command
# Use npm instead of pnpm for global install (pnpm requires setup, npm works out of the box)
RUN npm install -g .

# Copy Tailscale startup script
COPY scripts/fly-tailscale-start.sh /usr/local/bin/fly-tailscale-start.sh
RUN chmod +x /usr/local/bin/fly-tailscale-start.sh

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Create directory for Tailscale state (will be mounted at /data)
RUN mkdir -p /var/run/tailscale && chmod 755 /var/run/tailscale

# Note: We don't set USER node here because Tailscale needs root privileges.
# The entrypoint script will handle Tailscale setup as root, then switch to node user
# for running the gateway process.

# Use entrypoint script that handles Tailscale setup, then runs the gateway
# The script will run tailscale up as root, then exec the gateway as node user
ENTRYPOINT ["/usr/local/bin/fly-tailscale-start.sh"]

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
