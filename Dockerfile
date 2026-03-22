# syntax=docker/dockerfile:1.7

# Opt-in extension dependencies at build time (space-separated directory names).
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun. Works with Docker, Buildx, and Podman.
# The ext-deps stage extracts only the package.json files we need from
# extensions/, so the main build layer is not invalidated by unrelated
# extension source changes.
#
# Two runtime variants:
#   Default (bookworm):      docker build .
#   Slim (bookworm-slim):    docker build --build-arg OPENCLAW_VARIANT=slim .
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_VARIANT=default
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
COPY extensions /tmp/extensions
# Copy package.json for opted-in extensions so pnpm resolves their deps.
RUN mkdir -p /out && \
    for ext in $OPENCLAW_EXTENSIONS; do \
      if [ -f "/tmp/extensions/$ext/package.json" ]; then \
        mkdir -p "/out/$ext" && \
        cp "/tmp/extensions/$ext/package.json" "/out/$ext/package.json"; \
      fi; \
    done

# ── Stage 2: Build ──────────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build

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
COPY ui/package.json ./ui/package.json
COPY patches ./patches

COPY --from=ext-deps /out/ ./extensions/

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

COPY . .

# Normalize extension paths now so runtime COPY preserves safe modes
# without adding a second full extensions layer.
RUN for dir in /app/extensions /app/.agent /app/.agents; do \
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

# Install system utilities present in bookworm but missing in bookworm-slim.
# On the full bookworm image these are already installed (apt-get is a no-op).
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      procps hostname curl git lsof openssl gosu

RUN chown node:node /app

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
# Copy extensions that work on Fly.io shared-cpu machines.
# WhatsApp: Baileys 7.x is pure JS (no native bindings) — safe to include.
#   Pre-compiled .js files load without Jiti. Deps installed via OPENCLAW_EXTENSIONS=whatsapp.
# signal + imessage: not active channels but src/ has hardcoded imports to them.
COPY --from=runtime-assets --chown=node:node /app/extensions/telegram ./extensions/telegram
COPY --from=runtime-assets --chown=node:node /app/extensions/discord ./extensions/discord
COPY --from=runtime-assets --chown=node:node /app/extensions/slack ./extensions/slack
COPY --from=runtime-assets --chown=node:node /app/extensions/whatsapp ./extensions/whatsapp
COPY --from=runtime-assets --chown=node:node /app/extensions/signal ./extensions/signal
COPY --from=runtime-assets --chown=node:node /app/extensions/imessage ./extensions/imessage
COPY --from=runtime-assets --chown=node:node /app/extensions/shared ./extensions/shared
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs
# Extensions (telegram, discord, slack, etc.) are loaded as TypeScript at runtime via Jiti.
# They import from relative paths like "../../../src/infra/outbound/send-deps.js", which
# Jiti resolves to /app/src/. Without src/ here, all extension plugins fail to load.
COPY --from=runtime-assets --chown=node:node /app/src ./src
# WhatsApp plugin transitively imports tool-display.json from the shared iOS/macOS resources.
# Without this path, the whatsapp extension fails to load at runtime.
COPY --from=runtime-assets --chown=node:node /app/apps/shared/OpenClawKit/Sources/OpenClawKit/Resources ./apps/shared/OpenClawKit/Sources/OpenClawKit/Resources

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
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
    fi

# Install Blink Claw extended tools: bun (JS runtime), uv (Python pkg manager).
# nano-pdf (AI PDF editor). Requires python3-pip in OPENCLAW_DOCKER_APT_PACKAGES.
ARG OPENCLAW_INSTALL_BLINK_TOOLS=""
RUN if [ -n "$OPENCLAW_INSTALL_BLINK_TOOLS" ]; then \
      npm install -g bun && \
      (pip3 install uv nano-pdf linkedin-api 2>/dev/null || pip install uv nano-pdf linkedin-api 2>/dev/null || true); \
    fi

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
# Persist the Playwright browser cache path so playwright-core finds Chromium at runtime.
# Without this, the path is only set during the install RUN command and lost afterwards.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright && \
      PW_EXE=$(node -e "const {chromium}=require('/app/node_modules/playwright-core');process.stdout.write(chromium.executablePath())") && \
      [ -f "$PW_EXE" ] && ln -sf "$PW_EXE" /usr/bin/chromium || true; \
    fi

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

# Install Blink CLI — required for blink-* skill scripts (image, video, speech, transcribe, connectors)
# Uses @latest so every Docker image rebuild ships the newest CLI automatically.
# No manual version bumps needed — publishing a new CLI version is sufficient.
RUN npm install -g @blinkdotnew/cli@latest

# Install ClawHub CLI — the public skill registry for OpenClaw.
# Pre-installed so agents can run `clawhub install <skill>` to extend capabilities.
# Skills install to CLAWHUB_WORKDIR (/data/workspace) on the persistent Fly volume.
RUN npm install -g clawhub@latest
ENV CLAWHUB_WORKDIR=/data/workspace

# Expose the CLI binary without requiring npm global writes as non-root.
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

ENV NODE_ENV=production

# Redirect npm global installs to the Fly.io persistent volume (/data).
# This allows the non-root `node` user to run `npm install -g <pkg>` at runtime
# without permission errors. Installed packages survive container restarts.
ENV NPM_CONFIG_PREFIX=/data/npm-global
ENV PATH="/data/npm-global/bin:${PATH}"

# Pre-warm Jiti cache: boot the gateway once with WhatsApp enabled so Jiti
# compiles all TypeScript extensions during Docker build (not at runtime).
# Without this, WhatsApp/Baileys Jiti compilation takes 90-300s on shared CPUs.
# The compiled cache at node_modules/.cache/jiti/ bakes into the image layer.
# CACHE_BUST: v1 — change this comment to force layer rebuild after cache wipe.
RUN mkdir -p /tmp/oc-warmup/workspace/.whatsapp /tmp/oc-warmup/agents/main/agent && \
    printf '%s' '{"agents":{"defaults":{"workspace":"/tmp/oc-warmup/workspace"}},"gateway":{"auth":{"mode":"token"}},"browser":{"noSandbox":true},"channels":{"whatsapp":{"accounts":{"default":{"authDir":"/tmp/oc-warmup/workspace/.whatsapp"}}}}}' \
      > /tmp/oc-warmup/openclaw.json && \
    OPENCLAW_STATE_DIR=/tmp/oc-warmup \
    OPENCLAW_HEADLESS=true \
    OPENCLAW_GATEWAY_TOKEN=warmup \
    timeout 180 node openclaw.mjs gateway --allow-unconfigured 2>&1 & \
    GW_PID=$! && \
    for i in $(seq 1 60); do \
      if curl -sf http://127.0.0.1:18789/healthz > /dev/null 2>&1; then break; fi; \
      sleep 3; \
    done && \
    kill $GW_PID 2>/dev/null; wait $GW_PID 2>/dev/null || true && \
    rm -rf /tmp/oc-warmup && \
    chown -R node:node /app/node_modules/.cache 2>/dev/null || true && \
    echo "Jiti cache warmed (WhatsApp + all extensions pre-compiled)"

# Blink entrypoint: runs as root to prepare fresh Fly volumes (/data),
# then drops to node user via gosu before exec'ing the gateway.
COPY blink-entrypoint.sh /app/blink-entrypoint.sh
RUN chmod +x /app/blink-entrypoint.sh

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/blink-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
