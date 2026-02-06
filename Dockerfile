FROM node:22-bullseye-slim

# ✅ curl, unzip + build tools (git/make/cmake) zodat pnpm deps bouwen
RUN apt-get update && apt-get install -y curl unzip git build-essential cmake && \
    curl -fsSL https://bun.sh/install | bash && \
    corepack enable && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies installeren
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --config.auto-install-peers=true

# Source code kopiëren
COPY . .

# Build the TypeScript source code
RUN pnpm build

# Build Control UI assets (served by /ui)
RUN pnpm --filter openclaw-control-ui run build

# Install Playwright and Chromium browser
ENV PLAYWRIGHT_BROWSERS_PATH=/data/playwright-browsers
RUN pnpm add -w playwright && pnpm exec playwright install chromium

# Entrypoint instellen
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

# Default: start the gateway
# --bind lan ensures 0.0.0.0 binding for Railway healthchecks
# --allow-unconfigured allows starting without initial config
CMD ["node", "openclaw.mjs", "gateway", "run", "--bind", "lan", "--allow-unconfigured"]
