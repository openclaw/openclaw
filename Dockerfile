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

# Copy extension package.json files for dependency resolution
# NOTE: If lockfile is out of sync, run 'pnpm install' locally and commit updated pnpm-lock.yaml
COPY extensions/ ./extensions/

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build

# Build all extensions (K8s-native: pre-compile plugins)
# This ensures plugins use the same compiled modules as the gateway (avoids dual-package hazard)
RUN for ext in extensions/*/; do \
      if [ -f "$ext/package.json" ] && grep -q '"build"' "$ext/package.json"; then \
        echo "Building extension: $ext"; \
        (cd "$ext" && pnpm build) || true; \
      fi; \
    done
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges

# Create .openclaw directory with proper permissions (arbitrary UID)
# Runs containers with random UIDs in the root group (GID 0)
RUN mkdir -p /home/node/.openclaw/workspace && \
    chown -R node:0 /home/node/.openclaw && \
    chmod -R g=u /home/node/.openclaw

USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
