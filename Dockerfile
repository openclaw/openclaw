# syntax=docker/dockerfile:1.7

# Opt-in extension dependencies at build time (space-separated directory names).
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun. Works with Docker, Buildx, and Podman.
# The ext-deps stage extracts only the package.json files we need from the
# bundled plugin workspace tree, so the main build layer is not invalidated by
# unrelated plugin source changes.
#
# Two runtime variants:
#   Default (trixie):      docker build .
#   Slim (trixie-slim):    docker build --build-arg OPENCLAW_VARIANT=slim .
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_VARIANT=default
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_DOCKER_APT_UPGRADE=1
ARG OPENCLAW_NODE_TRIXIE_IMAGE="node:24-trixie@sha256:135dc9a66aef366e09958c18dab705081d77fb31eccffe8c3865fac9d3e42a1d"
ARG OPENCLAW_NODE_TRIXIE_DIGEST="sha256:135dc9a66aef366e09958c18dab705081d77fb31eccffe8c3865fac9d3e42a1d"
ARG OPENCLAW_NODE_TRIXIE_SLIM_IMAGE="node:24-trixie-slim@sha256:735dd688da64d22ebd9dd374b3e7e5a874635668fd2a6ec20ca1f99264294086"
ARG OPENCLAW_NODE_TRIXIE_SLIM_DIGEST="sha256:735dd688da64d22ebd9dd374b3e7e5a874635668fd2a6ec20ca1f99264294086"

# Base images are pinned to SHA256 digests for reproducible builds.
# Trade-off: digests must be updated manually when upstream tags move.
# To update, run: docker buildx imagetools inspect node:24-trixie (or podman)
# and replace the digest below with the current multi-arch manifest list entry.

FROM ${OPENCLAW_NODE_TRIXIE_IMAGE} AS ext-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Copy package.json for opted-in extensions so pnpm resolves their deps.
RUN --mount=type=bind,source=${OPENCLAW_BUNDLED_PLUGIN_DIR},target=/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR},readonly \
    mkdir -p /out && \
    for ext in $OPENCLAW_EXTENSIONS; do \
      if [ -f "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then \
        mkdir -p "/out/$ext" && \
        cp "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" "/out/$ext/package.json"; \
      fi; \
    done

# ── Stage 2: Build ──────────────────────────────────────────────
FROM ${OPENCLAW_NODE_TRIXIE_IMAGE} AS build
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

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs ./scripts/

COPY --from=ext-deps /out/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# pnpm v10+ may append peer-resolution hashes to virtual-store folder names; do not hardcode `.pnpm/...`
# paths. Fail fast here if the Matrix native binding did not materialize after install.
RUN echo "==> Verifying critical native addons..." && \
    find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q . || \
    (echo "ERROR: matrix-sdk-crypto native addon missing (pnpm install may have silently failed on this arch)" >&2 && exit 1)

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
RUN pnpm qa:lab:build

# Prune dev dependencies and strip build-only metadata before copying
# runtime assets into the final image.
FROM build AS runtime-assets
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Keep the install layer frozen, but allow prune to run against the full copied
# workspace tree subset used during `pnpm install`. The build stage only copied
# the root, `ui`, and opted-in plugin manifests into the install layer, so
# prune must not rediscover unrelated workspaces from the later full source
# copy.
RUN printf 'packages:\n  - .\n  - ui\n' > /tmp/pnpm-workspace.runtime.yaml && \
    for ext in $OPENCLAW_EXTENSIONS; do \
      printf '  - %s/%s\n' "$OPENCLAW_BUNDLED_PLUGIN_DIR" "$ext" >> /tmp/pnpm-workspace.runtime.yaml; \
    done && \
    cp /tmp/pnpm-workspace.runtime.yaml pnpm-workspace.yaml && \
    CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod && \
    node scripts/postinstall-bundled-plugins.mjs && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete

# ── Runtime base images ─────────────────────────────────────────
FROM ${OPENCLAW_NODE_TRIXIE_IMAGE} AS base-default
ARG OPENCLAW_NODE_TRIXIE_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-trixie" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_TRIXIE_DIGEST}"

FROM ${OPENCLAW_NODE_TRIXIE_SLIM_IMAGE} AS base-slim
ARG OPENCLAW_NODE_TRIXIE_SLIM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-trixie-slim" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_TRIXIE_SLIM_DIGEST}"

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

# Install system utilities present in trixie but missing in trixie-slim.
# On the full trixie image these are already installed (apt-get is a no-op).
# Smoke workflows can opt out of distro upgrades to cut repeated CI time while
# keeping the default runtime image behavior unchanged.
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    if [ "${OPENCLAW_DOCKER_APT_UPGRADE}" != "0" ]; then \
      DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends; \
    fi && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      procps hostname curl git lsof openssl

RUN chown node:node /app

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
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

# Install additional system packages needed by your skills or extensions.
# Example: docker build --build-arg OPENCLAW_DOCKER_APT_PACKAGES="python3 wget" .
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
    fi

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright; \
    fi

# Optionally install Docker CLI for sandbox container management.
# Build with: docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 ...
# Adds ~50MB. Only the CLI is installed — no Docker daemon.
# Required for agents.defaults.sandbox to function in Docker deployments.
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
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
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce-cli docker-compose-plugin; \
    fi

# Expose the CLI binary without requiring npm global writes as non-root.
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

# Install Codex CLI (floating — always latest; unpinned 2026-04-24)
RUN npm install -g @openai/codex@latest
# Install Claude Code CLI for Claude CLI backend
RUN npm install -g @anthropic-ai/claude-code

# Install GitHub CLI
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh

# Install utility tools (PDF + OCR + dev utilities + editors)
RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      jq \
      trash-cli \
      tree \
      sqlite3 \
      htop \
      vim \
      nano \
      ffmpeg \
      zip \
      unzip \
      git-lfs \
      rsync \
      python3-pip

# Install Python libraries (PDF + data analytics + testing + calendar)
RUN pip3 install --no-cache-dir --break-system-packages \
      pypdf \
      PyPDF2 \
      PyMuPDF \
      pdfplumber \
      pytest \
      icalendar \
      python-dateutil \
      yt-dlp \
      duckdb \
      numpy \
      pandas \
      matplotlib \
      plotly \
      playwright \
      dune-client

RUN --mount=type=cache,id=openclaw-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      python3 -m playwright install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright; \
    fi

# Install obsidian-headless CLI (floating)
RUN npm install -g obsidian-headless

# Symlink ob's config to the persisted openclaw volume
RUN mkdir -p /home/node/.config \
 && ln -sfn /home/node/.openclaw/obsidian-headless /home/node/.config/obsidian-headless \
 && chown -h node:node /home/node/.config /home/node/.config/obsidian-headless

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

# ── Local pipeline extensions ─────────────────────────────────────────────
# Retained from pre-2026.4.20: Rust toolchain + opendataloader-pdf pipeline.
# Not in upstream; kept as a local fork patch for pdf-pipeline/pdf-hybrid services.
ARG OPENCLAW_INSTALL_RUST=""
ARG OPENCLAW_INSTALL_PIPELINE=""
ARG OPENCLAW_PIPELINE_PY_PKG="opendataloader-pdf[hybrid]==2.2.1"
ARG OPENCLAW_PIPELINE_TORCH_INDEX="https://download.pytorch.org/whl/cpu"

RUN if [ -n "$OPENCLAW_INSTALL_RUST" ]; then \
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
        RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
        sh -s -- -y --no-modify-path --default-toolchain stable && \
      RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
        /usr/local/cargo/bin/rustup component add clippy rustfmt rust-analyzer && \
      for b in rustc cargo rustup rustfmt cargo-fmt rust-analyzer rustdoc rust-gdb rust-lldb; do \
        ln -sf /usr/local/cargo/bin/$b /usr/local/bin/$b 2>/dev/null || true; \
      done; \
    fi

RUN if [ -n "$OPENCLAW_INSTALL_PIPELINE" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless python3-pip python3-venv ripgrep git curl libgl1 && \
      python3 -m venv /opt/ocpipeline && \
      /opt/ocpipeline/bin/pip install --no-cache-dir \
        --extra-index-url "$OPENCLAW_PIPELINE_TORCH_INDEX" \
        torch torchvision && \
      /opt/ocpipeline/bin/pip install --no-cache-dir "$OPENCLAW_PIPELINE_PY_PKG"; \
    fi

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    OCPIPELINE_VENV=/opt/ocpipeline \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo

# Secret-to-env bridge: load file-based GitHub tokens into env vars at container start.
# Useful for CLIs like `gh` that expect GITHUB_TOKEN as an env var.
RUN printf '%s\n' \
    '#!/bin/bash' \
    'set -eu' \
    '# Load GITHUB_TOKEN from token file if present' \
    'if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "$GITHUB_TOKEN_FILE" ] && [ -z "${GITHUB_TOKEN:-}" ]; then' \
    '  export GITHUB_TOKEN="$(cat "$GITHUB_TOKEN_FILE")"' \
    'elif [ -n "${GITHUB_TOKEN_PATH:-}" ] && [ -r "$GITHUB_TOKEN_PATH" ] && [ -z "${GITHUB_TOKEN:-}" ]; then' \
    '  export GITHUB_TOKEN="$(cat "$GITHUB_TOKEN_PATH")"' \
    'fi' \
    '# Also set GH_TOKEN alias (some tools check it instead of GITHUB_TOKEN)' \
    'if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then' \
    '  export GH_TOKEN="$GITHUB_TOKEN"' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/openclaw-entrypoint.sh \
 && chmod 755 /usr/local/bin/openclaw-entrypoint.sh

# ── Local pipeline extensions ─────────────────────────────────────────────
# Retained from pre-2026.4.20: Rust toolchain + opendataloader-pdf pipeline.
# Not in upstream; kept as a local fork patch for pdf-pipeline/pdf-hybrid services.
ARG OPENCLAW_INSTALL_RUST=""
ARG OPENCLAW_INSTALL_PIPELINE=""
ARG OPENCLAW_PIPELINE_PY_PKG="opendataloader-pdf[hybrid]==2.2.1"
ARG OPENCLAW_PIPELINE_TORCH_INDEX="https://download.pytorch.org/whl/cpu"

RUN if [ -n "$OPENCLAW_INSTALL_RUST" ]; then \
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
        RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
        sh -s -- -y --no-modify-path --default-toolchain stable && \
      RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
        /usr/local/cargo/bin/rustup component add clippy rustfmt rust-analyzer && \
      for b in rustc cargo rustup rustfmt cargo-fmt rust-analyzer rustdoc rust-gdb rust-lldb; do \
        ln -sf /usr/local/cargo/bin/$b /usr/local/bin/$b 2>/dev/null || true; \
      done; \
    fi

RUN if [ -n "$OPENCLAW_INSTALL_PIPELINE" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless python3-pip python3-venv ripgrep git curl libgl1 && \
      python3 -m venv /opt/ocpipeline && \
      /opt/ocpipeline/bin/pip install --no-cache-dir \
        --extra-index-url "$OPENCLAW_PIPELINE_TORCH_INDEX" \
        torch torchvision && \
      /opt/ocpipeline/bin/pip install --no-cache-dir "$OPENCLAW_PIPELINE_PY_PKG"; \
    fi

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    OCPIPELINE_VENV=/opt/ocpipeline \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo

# Secret-to-env bridge: load file-based secrets into env vars at container start.
# Useful for CLIs like `gh` that expect GITHUB_TOKEN as an env var, not a file path.
RUN printf '%s\n' \
    '#!/bin/bash' \
    'set -eu' \
    '# Load GITHUB_TOKEN from secret file if present' \
    'if [ -n "${GITHUB_TOKEN_PATH:-}" ] && [ -r "$GITHUB_TOKEN_PATH" ] && [ -z "${GITHUB_TOKEN:-}" ]; then' \
    '  export GITHUB_TOKEN="$(cat "$GITHUB_TOKEN_PATH")"' \
    'fi' \
    '# Also set GH_TOKEN alias (some tools check it instead of GITHUB_TOKEN)' \
    'if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then' \
    '  export GH_TOKEN="$GITHUB_TOKEN"' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/openclaw-entrypoint.sh \
 && chmod 755 /usr/local/bin/openclaw-entrypoint.sh

# Security hardening: Run as non-root user
# The node:24-trixie image includes a 'node' user (uid 1000)
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
ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
