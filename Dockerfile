# Opt-in plugin dependencies at build time (space- or comma-separated directory names).
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun while still allowing optional runtime tooling for
# Docker-hosted workflows. Works with Docker, Buildx, and Podman.
# The dependency manifest stages extract only package.json files from the
# workspace and selected bundled plugins, so the main build layer is not
# invalidated by unrelated source changes.
#
# Build stages use full bookworm; the runtime image is always bookworm-slim.
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST="sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"
# Keep in sync with .github/actions/setup-node-env/action.yml bun-version.
# To update: docker buildx imagetools inspect oven/bun:<version> and use the manifest-list digest.
ARG OPENCLAW_BUN_IMAGE="oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"

# Base images are pinned to SHA256 digests for reproducible builds.
# Dependabot refreshes these blessed digests; release builds consume the
# reviewed base snapshot instead of mutating distro state on every build.
# To update, run: docker buildx imagetools inspect node:24-bookworm and
# node:24-bookworm-slim (or podman) and replace the digests below with the
# current multi-arch manifest list entries.

FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Copy package.json files for workspace packages used by the install layer.
RUN --mount=type=bind,source=packages,target=/tmp/packages,readonly \
    --mount=type=bind,source=${OPENCLAW_BUNDLED_PLUGIN_DIR},target=/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR},readonly \
    mkdir -p /out/packages "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}" && \
    for manifest in /tmp/packages/*/package.json; do \
      [ -f "$manifest" ] || continue; \
      pkg_dir="${manifest%/package.json}"; \
      pkg_name="${pkg_dir##*/}"; \
      mkdir -p "/out/packages/$pkg_name" && \
      cp "$manifest" "/out/packages/$pkg_name/package.json"; \
    done && \
    for ext in $(printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' '); do \
      if [ -f "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then \
        mkdir -p "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext" && \
        cp "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json"; \
      fi; \
    done

# ── Stage 2: Build ──────────────────────────────────────────────
FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
ARG OPENCLAW_EXTENSIONS

# Copy pinned Bun binary from the official image instead of fetching via curl.
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun

RUN corepack enable

ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV GOPATH=/home/node/go
ENV PATH="/usr/local/go/bin:${PNPM_HOME}:${NPM_CONFIG_PREFIX}/bin:${GOPATH}/bin:${PATH}"
RUN mkdir -p "${PNPM_HOME}" "${NPM_CONFIG_PREFIX}/bin" "${GOPATH}/bin" && \
  chown -R node:node /home/node/.local /home/node/.npm-global /home/node/go

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs scripts/prepare-git-hooks.mjs ./scripts/
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs

COPY --from=workspace-deps /out/packages/ ./packages/
COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc

# pnpm v10+ may append peer-resolution hashes to virtual-store folder names; do not hardcode `.pnpm/...`
# paths. Matrix's native downloader can hit transient release CDN errors while
# still exiting successfully, so retry the package downloader before failing.
# Skip the entire check when matrix is not a bundled extension (e.g. msteams-only builds).
RUN set -eux; \
    if ! printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' ' | tr ' ' '\n' | grep -qx 'matrix'; then \
      echo "==> matrix not bundled, skipping matrix-sdk-crypto check"; \
      exit 0; \
    fi; \
    echo "==> Verifying critical native addons..."; \
    for attempt in 1 2 3 4 5; do \
      if find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q .; then \
        exit 0; \
      fi; \
      echo "matrix-sdk-crypto native addon missing; retrying download (${attempt}/5)"; \
      node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js || true; \
      sleep $((attempt * 2)); \
    done; \
    find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q . || \
      (echo "ERROR: matrix-sdk-crypto native addon missing after retries" >&2 && exit 1)

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
RUN pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p extensions/canvas/src/host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
     echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm_config_verify_deps_before_run=false pnpm build:docker
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm_config_verify_deps_before_run=false pnpm ui:build
RUN pnpm_config_verify_deps_before_run=false pnpm qa:lab:build

# Prune dev dependencies, omitted plugin runtime packages, and build-only
# metadata before copying runtime assets into the final image.
FROM build AS runtime-assets
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# BuildKit cache mounts are not part of cached layers; seed tarballs for the
# installed prod graph in the same step that runs offline prune.
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm list --prod --depth Infinity --json | node scripts/list-prod-store-packages.mjs | xargs -r pnpm store add && \
    CI=true pnpm prune --prod \
      --config.offline=true \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc && \
    OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs && \
    node scripts/postinstall-bundled-plugins.mjs && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete && \
    node scripts/check-package-dist-imports.mjs /app

# ── Runtime base image ──────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST}"

# ── Stage 3: Runtime ────────────────────────────────────────────
FROM base-runtime
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

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

# Install runtime system utilities missing from bookworm-slim.
# `ca-certificates` ships in `bookworm` (full) but not in `bookworm-slim`,
# so it must be installed explicitly here. Without it `/etc/ssl/certs/`
# stays empty and every HTTPS outbound dies at TLS handshake with
# `error setting certificate file`.
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git hostname lsof openssl procps python3 tini && \
    update-ca-certificates
RUN chown node:node /app
# Keep these dirs writable in the baked image; docker-compose.yml also repairs
# them at container start when OPENCLAW_HOME_VOLUME hides /home/node.
RUN mkdir -p /home/node/.cache "${PNPM_HOME}" "${NPM_CONFIG_PREFIX}/bin" "${COREPACK_HOME}" \
    "${GOPATH}/bin" "${HOMEBREW_REPOSITORY}" "${HOMEBREW_CELLAR}" "${HOMEBREW_PREFIX}/bin" && \
    chown -R node:node /home/node/.cache /home/node/.local /home/node/.npm-global /home/node/go /home/linuxbrew "${COREPACK_HOME}"
RUN corepack enable

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .
COPY --from=runtime-assets --chown=node:node /app/patches ./patches
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
COPY --from=runtime-assets --chown=node:node /app/src/agents/templates ./src/agents/templates
COPY --from=runtime-assets --chown=node:node /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} ./${OPENCLAW_BUNDLED_PLUGIN_DIR}
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs
COPY --from=runtime-assets --chown=node:node /app/qa ./qa

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

# Install baseline runtime packages needed by Docker-hosted workflows, plus
# optional extra packages needed by local skills or plugins.
# Example: docker build --build-arg OPENCLAW_IMAGE_APT_PACKAGES="python3 wget" .
# Legacy alias: OPENCLAW_DOCKER_APT_PACKAGES is still accepted as a fallback.
ARG OPENCLAW_DOCKER_APT_UPGRADE=1
ARG OPENCLAW_IMAGE_APT_PACKAGES
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
    REQUESTED_APT_PACKAGES="${OPENCLAW_IMAGE_APT_PACKAGES-$OPENCLAW_DOCKER_APT_PACKAGES}"; \
    EXTRA_APT_PACKAGES=""; \
    for pkg in $REQUESTED_APT_PACKAGES; do \
      case " ${BASE_APT_PACKAGES} " in \
        *" ${pkg} "*) ;; \
        *) EXTRA_APT_PACKAGES="${EXTRA_APT_PACKAGES} ${pkg}" ;; \
      esac; \
    done; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${BASE_APT_PACKAGES} ${EXTRA_APT_PACKAGES}

# Install additional Python packages needed by your plugins or skills.
# Example: docker build --build-arg OPENCLAW_IMAGE_PIP_PACKAGES="requests humanize" .
ARG OPENCLAW_IMAGE_PIP_PACKAGES=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_IMAGE_PIP_PACKAGES" ]; then \
      python3 -m pip install --no-cache-dir --break-system-packages $OPENCLAW_IMAGE_PIP_PACKAGES; \
    fi

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
ENV OPENCLAW_PLAYWRIGHT_BROWSERS_PATH=/opt/openclaw/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/openclaw/ms-playwright
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
# Pin Go so Docker rebuilds stay reproducible across hosts and CI runs.
ARG GO_VERSION=1.26.1
ARG GO_LINUX_AMD64_SHA256=031f088e5d955bab8657ede27ad4e3bc5b7c1ba281f05f245bcc304f327c987a
ARG GO_LINUX_ARM64_SHA256=a290581cfe4fe28ddd737dde3095f3dbeb7f2e4065cab4eae44dfc53b760c2f7
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
  amd64) GOARCH=amd64; GOSHA256="$GO_LINUX_AMD64_SHA256" ;; \
  arm64) GOARCH=arm64; GOSHA256="$GO_LINUX_ARM64_SHA256" ;; \
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  GOVERSION="go${GO_VERSION#go}"; \
  echo "Installing ${GOVERSION} for linux-${GOARCH}"; \
  curl -fsSL "https://go.dev/dl/${GOVERSION}.linux-${GOARCH}.tar.gz" -o /tmp/go.tgz; \
  printf '%s  %s\n' "$GOSHA256" /tmp/go.tgz | sha256sum -c -; \
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
ARG GOGCLI_DEFAULT_TAG=v0.11.0
ARG GOGCLI_LINUX_AMD64_SHA256=ca98ba56e29ccd3713fe7bf835fdca00ae1b97cdcb7b0bc5e393e7edb4089c84
ARG GOGCLI_LINUX_ARM64_SHA256=1bfe980545641501488fed93c66fc76671c72a4605285f574572dac700efdd35
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
  amd64) GOGARCH=amd64; GOGSHA256="$GOGCLI_LINUX_AMD64_SHA256" ;; \
  arm64) GOGARCH=arm64; GOGSHA256="$GOGCLI_LINUX_ARM64_SHA256" ;; \
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
  asset="gogcli_${ver}_linux_${GOGARCH}.tar.gz"; \
  if [ "$tag" != "$GOGCLI_DEFAULT_TAG" ] || [ -z "$GOGSHA256" ]; then \
    GOGSHA256="$(curl -fsSL "https://github.com/steipete/gogcli/releases/download/$tag/checksums.txt" | awk -v asset="$asset" '$2 == asset { print $1; exit }')"; \
  fi; \
  if [ -z "$GOGSHA256" ]; then \
    echo "ERROR: Missing checksum for $asset" >&2; \
    exit 1; \
  fi; \
  url="https://github.com/steipete/gogcli/releases/download/$tag/gogcli_${ver}_linux_${GOGARCH}.tar.gz"; \
  echo "Downloading: $url"; \
  curl -fsSL "$url" -o /tmp/gogcli.tgz; \
  printf '%s  %s\n' "$GOGSHA256" /tmp/gogcli.tgz | sha256sum -c -; \
  tar -xzf /tmp/gogcli.tgz -C /tmp; \
  install -m 0755 /tmp/gog /usr/local/bin/gog; \
  rm -f /tmp/gog /tmp/gogcli.tgz; \
  gog --help >/dev/null

# Install Linuxbrew in a node-writable prefix so brew installs work at runtime.
# Pin the Homebrew source tarball for reproducible Docker builds.
ARG HOMEBREW_BREW_TAG=5.1.3
RUN set -eux; \
  curl -fsSL "https://github.com/Homebrew/brew/archive/refs/tags/${HOMEBREW_BREW_TAG}.tar.gz" | tar xz --strip-components=1 -C "${HOMEBREW_REPOSITORY}"; \
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
      # Require exactly one primary key (`pub` in --with-colons; subkeys use `sub`) so we
      # never pin the first fingerprint while apt trusts extra keys from the same file.
      # Update OPENCLAW_DOCKER_GPG_FINGERPRINT when Docker rotates release keys.
      curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
      expected_fingerprint="$(printf '%s' "$OPENCLAW_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
      docker_gpg_pub_count="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "pub" { c++ } END { print c+0 }')" && \
      if [ "$docker_gpg_pub_count" != "1" ]; then \
        echo "ERROR: Docker apt key must contain exactly one public key (found $docker_gpg_pub_count); refusing a multi-key file." >&2; \
        exit 1; \
      fi && \
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

# Pre-create default named-volume mount points so first-run Docker volumes copy
# node ownership from the image instead of starting as root-owned directories.
# NOTE: /home/node/.config must be created with node ownership first so that
# the leaf /home/node/.config/openclaw inherits the correct parent permissions.
# Without this, install -d leaves /home/node/.config as root:root (issue #85968).
RUN install -d -m 0755 -o node -g node /home/node/.config && \
    install -d -m 0700 -o node -g node \
      /home/node/.openclaw \
      /home/node/.openclaw/workspace \
      /home/node/.config/openclaw && \
    stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700' && \
    stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700' && \
    stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755' && \
    stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'

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
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "openclaw.mjs", "gateway"]
