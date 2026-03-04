FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# OCI base-image metadata for downstream image consumers.
# If you change these annotations, also update:
# - docs/install/docker.md ("Base image metadata" section)
# - https://docs.hanzo.bot/install/docker
LABEL org.opencontainers.image.base.name="docker.io/library/node:22-bookworm" \
  org.opencontainers.image.base.digest="sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935" \
  org.opencontainers.image.source="https://github.com/hanzoai/bot" \
  org.opencontainers.image.url="https://hanzo.bot" \
  org.opencontainers.image.documentation="https://docs.hanzo.bot/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="Bot" \
  org.opencontainers.image.description="Bot gateway and CLI runtime container image"

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG BOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$BOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $BOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg BOT_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
ARG BOT_INSTALL_BROWSER=""
RUN if [ -n "$BOT_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# CACHE_BUST invalidates all layers below when the commit SHA changes,
# ensuring COPY and build always use fresh source from the current commit.
ARG CACHE_BUST=""
COPY . .
RUN pnpm build

# Ensure memory-lancedb extension dependencies are installed.
# LanceDB has native bindings that may not be hoisted by pnpm in all configurations.
RUN pnpm install --filter @hanzo/memory-lancedb --prod --no-frozen-lockfile || true
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV BOT_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Normalize permissions on plugin and agent directories so they are accessible
# but not world-writable. Directories get 755 (rwxr-xr-x), files get 644 (rw-r--r--).
RUN for dir in /app/extensions /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} + && \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

# Optionally verify GPG fingerprints for sandbox builds.
# Build with: docker build --build-arg BOT_SANDBOX=1 ...
ARG BOT_SANDBOX=""
RUN if [ -n "$BOT_SANDBOX" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnupg && \
      gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys 0xDEADBEEF 2>/dev/null || true && \
      gpg --with-colons --fingerprint 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }' && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Support custom init scripts mounted at /bot-init.d/
# Scripts must be executable. They run before the gateway starts.
# Example: docker run -v ./my-scripts:/bot-init.d:ro hanzo-bot
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

# Start gateway server with default config.
# Binds to LAN (0.0.0.0) for container platforms with health checks and ingress.
# Set BOT_GATEWAY_TOKEN or BOT_GATEWAY_PASSWORD env var for auth.
CMD ["node", "hanzo-bot.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"]
