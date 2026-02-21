FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
USER root
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

USER node
COPY --chown=node:node . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Docker-specific startup optimizations:
# - Skip the process respawn that adds ~200ms (warning flag passed via CMD instead)
ENV OPENCLAW_NO_RESPAWN=1
# - Skip mDNS/Bonjour discovery (not useful inside a container)
ENV OPENCLAW_DISABLE_BONJOUR=1
# - Skip canvas host server startup probe
ENV OPENCLAW_SKIP_CANVAS_HOST=1
# - Enable Node.js compile cache for faster subsequent startups
ENV NODE_COMPILE_CACHE=/app/.node-compile-cache

# Pre-warm the Node.js compile cache so it's baked into the image.
RUN node --disable-warning=ExperimentalWarning openclaw.mjs --help 2>/dev/null || true

# Pre-warm jiti's filesystem cache for bundled plugins.
# jiti transpiles TypeScript extensions at runtime; without a warm cache this
# adds ~16s to cold start. The cache lives in node_modules/.cache/jiti.
RUN mkdir -p node_modules/.cache/jiti && \
    node --disable-warning=ExperimentalWarning scripts/warmup-jiti-cache.mjs 2>/dev/null || true

# Allow non-root user to write temp files during runtime/tests.
# Runs after cache pre-warming so warm cache files are also owned by node.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","--disable-warning=ExperimentalWarning","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "--disable-warning=ExperimentalWarning", "openclaw.mjs", "gateway", "--allow-unconfigured"]
