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
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Install Python for financial calculations (Bea uses Python via exec tool)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && pip3 install --break-system-packages requests && rm -rf /var/lib/apt/lists/*

# Copy workspace defaults into the image (NOT the live workspace)
COPY workspace-defaults/ /opt/openbea/workspace-defaults/

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app
RUN chmod +x /app/scripts/docker-entrypoint.sh

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
#
# Entrypoint seeds openclaw.json (device auth disabled) when missing.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
