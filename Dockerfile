# =============================================================================
# Stage 1: Build
# Installs all dependencies (including dev), compiles the project, then strips
# build-only artifacts before handoff to the runtime stage.
# =============================================================================
FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935 AS builder

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

# ---------------------------------------------------------------------------
# Slim down: remove build-only artifacts that are not needed at runtime.
# ---------------------------------------------------------------------------

# Prune dev dependencies (~237MB): typescript, vitest, rolldown, oxlint, etc.
RUN CI=true pnpm prune --prod

# Remove source, tests, build configs, and docs (runtime uses dist/ only).
RUN rm -rf src/ test/ docs/ scripts/ patches/ \
  tsconfig*.json tsdown.config.* vitest.*.config.* oxlintrc.json \
  .oxfmt* .editorconfig .gitignore .gitattributes .npmignore

# =============================================================================
# Stage 2: Runtime
# Same base as the builder so all system libraries and native modules work
# identically. The multi-stage split eliminates the Bun installation (~102MB),
# the full Debian build toolchain, and — most importantly — the ~1.7GB layer
# that the old single-stage `chown -R node:node /app` created by duplicating
# every file's data just to change ownership metadata.
# =============================================================================
FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

WORKDIR /app

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ] || [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
  apt-get update && \
  if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
  fi && \
  if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb; \
  fi && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

# Copy the built & pruned application with correct ownership.
# Using COPY --chown avoids a separate `chown -R` layer that would duplicate
# all file data in a new layer (saves ~1.7GB).
COPY --from=builder --chown=node:node /app /app

# Install Chromium after COPY so playwright-core is available from node_modules.
# Must run as root before USER node.
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
  node /app/node_modules/playwright-core/cli.js install --with-deps chromium; \
  fi

ENV NODE_ENV=production

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
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
