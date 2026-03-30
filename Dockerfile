# syntax=docker/dockerfile:1.7

# Opt-in extension dependencies at build time (space-separated directory names).
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun while still allowing optional runtime tooling for
# Docker-hosted workflows. Works with Docker, Buildx, and Podman.
# The ext-deps stage extracts only the package.json files we need from the
# bundled plugin workspace tree, so the main build layer is not invalidated by
# unrelated plugin source changes.
#
# Two runtime variants:
#   Default (bookworm):      docker build .
#   Slim (bookworm-slim):    docker build --build-arg OPENCLAW_VARIANT=slim .
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_VARIANT=default
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_DOCKER_APT_UPGRADE=1
ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"
ARG OPENCLAW_NODE_BOOKWORM_DIGEST="sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST="sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"

# Base images are pinned to SHA256 digests for reproducible builds.
# Trade-off: digests must be updated manually when upstream tags move.
# To update, run: docker buildx imagetools inspect node:24-bookworm (or podman)
# and replace the digest below with the current multi-arch manifest list entry.

FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS ext-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
COPY ${OPENCLAW_BUNDLED_PLUGIN_DIR} /tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}
# Copy package.json for opted-in extensions so pnpm resolves their deps.
RUN mkdir -p /out && \
    for ext in $OPENCLAW_EXTENSIONS; do \
      if [ -f "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then \
        mkdir -p "/out/$ext" && \
        cp "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" "/out/$ext/package.json"; \
      fi; \
    done

# ── Stage 2: Build ──────────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

# Install Bun (required for build scripts). Retry the whole bootstrap flow to
# tolerate transient 5xx failures from bun.sh/GitHub during CI image builds.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      if curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://bun.sh/install | bash; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then \
        exit 1; \
      fi; \
      sleep $((attempt * 2)); \
    done
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV GOPATH=/home/node/go
ENV PATH="/usr/local/go/bin:${PNPM_HOME}:${NPM_CONFIG_PREFIX}/bin:${GOPATH}/bin:${PATH}"
RUN mkdir -p "${PNPM_HOME}" "${NPM_CONFIG_PREFIX}/bin" "${GOPATH}/bin" && \
  chown -R node:node /home/node/.local /home/node/.npm-global /home/node/go

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs ./scripts/postinstall-bundled-plugins.mjs

COPY --from=ext-deps /out/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

COPY . .

# Normalize extension paths now so runtime COPY preserves safe modes
# without adding a second full extensions layer.
RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

# A2UI bundle may fail under QEMU cross-compilation (e.g. building amd64
# on Apple Silicon). CI builds natively per-arch so this is a no-op there.
# Stub it so local cross-arch builds still succeed.
RUN pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p src/canvas-host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > src/canvas-host/a2ui/a2ui.bundle.js && \
     echo "stub" > src/canvas-host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
RUN pnpm build:docker
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Prune dev dependencies and strip build-only metadata before copying
# runtime assets into the final image.
FROM build AS runtime-assets
RUN CI=true pnpm prune --prod && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete

# ── Runtime base images ─────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS base-default
ARG OPENCLAW_NODE_BOOKWORM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_BOOKWORM_DIGEST}"

FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-slim
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST}"

# ── Stage 3: Runtime ────────────────────────────────────────────
FROM base-${OPENCLAW_VARIANT}
ARG OPENCLAW_VARIANT
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
ARG OPENCLAW_DOCKER_APT_UPGRADE

# OCI base-image metadata for downstream image consumers.
# If you change these annotations, also update:
# - docs/install/docker.md ("Base image metadata" section)
# - https://docs.openclaw.ai/install/docker
LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

WORKDIR /app
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV COREPACK_HOME=/usr/local/share/corepack
ENV GOPATH=/home/node/go
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew
ENV HOMEBREW_CELLAR=/home/linuxbrew/.linuxbrew/Cellar
ENV HOMEBREW_REPOSITORY=/home/linuxbrew/.linuxbrew/Homebrew
ENV PATH="/usr/local/go/bin:${PNPM_HOME}:${NPM_CONFIG_PREFIX}/bin:${GOPATH}/bin:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:${PATH}"
RUN chown node:node /app
RUN mkdir -p /home/node/.cache "${PNPM_HOME}" "${NPM_CONFIG_PREFIX}/bin" "${COREPACK_HOME}" \
    "${GOPATH}/bin" "${HOMEBREW_REPOSITORY}" "${HOMEBREW_CELLAR}" "${HOMEBREW_PREFIX}/bin" && \
    chown -R node:node /home/node/.cache /home/node/.local /home/node/.npm-global /home/node/go /home/linuxbrew "${COREPACK_HOME}"
RUN corepack enable

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
COPY --from=runtime-assets --chown=node:node /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} ./${OPENCLAW_BUNDLED_PLUGIN_DIR}
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs

# In npm-installed Docker images, prefer the copied source extension tree for
# bundled discovery so package metadata that points at source entries stays valid.
ENV OPENCLAW_BUNDLED_PLUGINS_DIR=/app/${OPENCLAW_BUNDLED_PLUGIN_DIR}

# Keep pnpm available in the runtime image for container-local workflows.
# Use a shared Corepack home so the non-root `node` user does not need a
# first-run network fetch when invoking pnpm.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN install -d -m 0755 "$COREPACK_HOME" && \
    corepack enable && \
    for attempt in 1 2 3 4 5; do \
      if corepack prepare "$(node -p "require('./package.json').packageManager")" --activate; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then \
        exit 1; \
      fi; \
      sleep $((attempt * 2)); \
    done && \
    chmod -R a+rX "$COREPACK_HOME"

# Install baseline system packages needed by the slim runtime and common
# Docker workflows. Smoke workflows can opt out of distro upgrades to cut
# repeated CI time, and extra packages can still be layered in without
# reinstalling duplicates.
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    set -eux; \
    apt-get update; \
    if [ "${OPENCLAW_DOCKER_APT_UPGRADE}" != "0" ]; then \
      DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends; \
    fi; \
    BASE_APT_PACKAGES="\
cron gosu \
git curl wget ca-certificates jq unzip ripgrep procps hostname openssl lsof file \
python3 python3-pip python3-venv \
xvfb xauth \
libgbm1 libnss3 libasound2 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxss1 libgtk-3-0"; \
    EXTRA_APT_PACKAGES=""; \
    for pkg in $OPENCLAW_DOCKER_APT_PACKAGES; do \
      case " ${BASE_APT_PACKAGES} " in \
        *" ${pkg} "*) ;; \
        *) EXTRA_APT_PACKAGES="${EXTRA_APT_PACKAGES} ${pkg}" ;; \
      esac; \
    done; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${BASE_APT_PACKAGES} ${EXTRA_APT_PACKAGES}

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
ENV OPENCLAW_PLAYWRIGHT_BROWSERS_PATH=/opt/openclaw/ms-playwright
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      mkdir -p "$OPENCLAW_PLAYWRIGHT_BROWSERS_PATH" && \
      PLAYWRIGHT_BROWSERS_PATH="$OPENCLAW_PLAYWRIGHT_BROWSERS_PATH" \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chmod -R a+rX "$OPENCLAW_PLAYWRIGHT_BROWSERS_PATH" && \
      chown -R node:node "$OPENCLAW_PLAYWRIGHT_BROWSERS_PATH"; \
    fi

# ---- Install Go (official) ----
# Fetch the latest stable version from go.dev and install the correct arch.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
  amd64) GOARCH=amd64 ;; \
  arm64) GOARCH=arm64 ;; \
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  GOVERSION="$(curl -fsSL 'https://go.dev/dl/?mode=json' | jq -r 'map(select(.stable==true)) | .[0].version')" ; \
  echo "Installing Go ${GOVERSION} for linux-${GOARCH}"; \
  curl -fsSL "https://go.dev/dl/${GOVERSION}.linux-${GOARCH}.tar.gz" -o /tmp/go.tgz; \
  rm -rf /usr/local/go; \
  tar -C /usr/local -xzf /tmp/go.tgz; \
  rm -f /tmp/go.tgz; \
  /usr/local/go/bin/go version

# Ensure Go is first in PATH (no old go ahead of it)
ENV PATH="/usr/local/go/bin:${PATH}"

# ---- Install gog (gogcli) ----
# Pin version by setting GOGCLI_TAG at build time.
# Default stays pinned for reproducible CI builds.
ARG GOGCLI_TAG=v0.11.0
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
  amd64) GOGARCH=amd64 ;; \
  arm64) GOGARCH=arm64 ;; \
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  tag="$GOGCLI_TAG"; \
  if [ "$tag" = "latest" ]; then \
  tag="$(curl -fsSI -H 'User-Agent: openclaw-docker-build' https://github.com/steipete/gogcli/releases/latest | awk 'tolower($1)==\"location:\" {print $2}' | tr -d '\r' | awk -F/ '{print $NF}' | tail -n1)"; \
  if [ -z "$tag" ]; then \
    echo "WARN: Failed to resolve gogcli latest release tag; falling back to v0.11.0" >&2; \
    tag="v0.11.0"; \
  fi; \
  fi; \
  ver="${tag#v}"; \
  url="https://github.com/steipete/gogcli/releases/download/$tag/gogcli_${ver}_linux_${GOGARCH}.tar.gz"; \
  echo "Downloading: $url"; \
  curl -fsSL "$url" -o /tmp/gogcli.tgz; \
  tar -xzf /tmp/gogcli.tgz -C /tmp; \
  install -m 0755 /tmp/gog /usr/local/bin/gog; \
  rm -f /tmp/gog /tmp/gogcli.tgz; \
  gog --help >/dev/null

# Install Linuxbrew in a node-writable prefix so brew installs work at runtime.
RUN set -eux; \
  curl -fsSL https://github.com/Homebrew/brew/tarball/master | tar xz --strip-components=1 -C "${HOMEBREW_REPOSITORY}"; \
  ln -sf ../Homebrew/bin/brew "${HOMEBREW_PREFIX}/bin/brew"; \
  chown -R node:node /home/linuxbrew
RUN gosu node brew --version >/dev/null

# Optionally install Docker CLI for sandbox container management.
# Build with: docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 ...
# Adds ~50MB. Only the CLI is installed — no Docker daemon.
# Required for agents.defaults.sandbox to function in Docker deployments.
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg && \
      install -m 0755 -d /etc/apt/keyrings && \
      # Verify Docker apt signing key fingerprint before trusting it as a root key.
      # Update OPENCLAW_DOCKER_GPG_FINGERPRINT when Docker rotates release keys.
      curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
      expected_fingerprint="$(printf '%s' "$OPENCLAW_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
      actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" && \
      if [ -z "$actual_fingerprint" ] || [ "$actual_fingerprint" != "$expected_fingerprint" ]; then \
        echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2; \
        exit 1; \
      fi && \
      gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc && \
      rm -f /tmp/docker.gpg.asc && \
      chmod a+r /etc/apt/keyrings/docker.gpg && \
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce-cli docker-compose-plugin; \
    fi

COPY --from=build --chown=node:node /app/scripts/docker ./scripts/docker
# Normalize extension paths so plugin safety checks do not reject
# world-writable directories inherited from source file modes.
RUN for dir in /app/extensions /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done
RUN chmod +x scripts/docker/gateway-entrypoint.sh scripts/docker/playwright-chromium.sh
# Expose the CLI binary without requiring npm global writes as non-root.
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && ln -sf /app/scripts/docker/playwright-chromium.sh /usr/local/bin/openclaw-playwright-chromium \
 && chmod 755 /app/openclaw.mjs

ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:24-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# IMPORTANT: With Docker bridge networking (-p 18789:18789), loopback bind
# makes the gateway unreachable from the host. Either:
#   - Use --network host, OR
#   - Override --bind to "lan" (0.0.0.0) and set auth credentials
#
# Built-in probe endpoints for container health checks:
#   - GET /healthz (liveness) and GET /readyz (readiness)
#   - aliases: /health and /ready
# For external access from host/ingress, override bind to "lan" and set auth.
HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
