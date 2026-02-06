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

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# ---- Render/Container start script ----
# Bind to lan + use $PORT, and load trusted proxy config
RUN printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  '' \
  'PORT="${PORT:-8080}"' \
  '' \
  'exec node dist/index.js gateway \' \
  '  --allow-unconfigured \' \
  '  --bind lan \' \
  '  --port "$PORT" \' \
  '  --config /app/openclaw.config.json' \
  > /app/start-render.sh && chmod +x /app/start-render.sh && chown node:node /app/start-render.sh

# Security hardening: Run as non-root user
USER node

# Start gateway server for Render
CMD ["/app/start-render.sh"]
