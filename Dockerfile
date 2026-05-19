# syntax=docker/dockerfile:1.7

ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:22-bookworm"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:22-bookworm-slim"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST=""
ARG OPENCLAW_BUN_IMAGE="oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"

FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS ext-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
RUN --mount=type=bind,source=${OPENCLAW_BUNDLED_PLUGIN_DIR},target=/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR},readonly \
    mkdir -p /out && \
    for ext in $(printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' '); do \
      if [ -f "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then \
        mkdir -p "/out/$ext" && \
        cp "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" "/out/$ext/package.json"; \
      fi; \
    done

FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs ./scripts/
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs

COPY --from=ext-deps /out/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/

RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

RUN set -eux; \
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

RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

RUN pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p extensions/canvas/src/host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
     echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm build:docker
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build
RUN pnpm qa:lab:build

FROM build AS runtime-assets
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
RUN printf 'packages:\n  - .\n  - ui\n' > /tmp/pnpm-workspace.runtime.yaml && \
    for ext in $(printf '%s\n' "$OPENCLAW_EXTENSIONS" | tr ',' ' '); do \
      printf '  - %s/%s\n' "$OPENCLAW_BUNDLED_PLUGIN_DIR" "$ext" >> /tmp/pnpm-workspace.runtime.yaml; \
    done && \
    cp /tmp/pnpm-workspace.runtime.yaml pnpm-workspace.yaml && \
    CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod && \
    node scripts/postinstall-bundled-plugins.mjs && \
    OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" node scripts/prune-docker-plugin-dist.mjs && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete && \
    node scripts/check-package-dist-imports.mjs /app

FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:22-bookworm-slim" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST}"

FROM base-runtime
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

WORKDIR /app

RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates procps hostname curl git lsof openssl python3 tini jq && \
    update-ca-certificates

# Install Supercronic: container-friendly cron runner.
# Runs as the current user, logs to stdout/stderr, and does not need root-owned /var/run pid files.
ARG SUPERCRONIC_VERSION=v0.2.33
ARG SUPERCRONIC_ARCH=amd64
RUN curl -fsSL \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SUPERCRONIC_ARCH}" \
      -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic \
    && supercronic -version

RUN chown node:node /app

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/patches ./patches
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
COPY --from=runtime-assets --chown=node:node /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} ./${OPENCLAW_BUNDLED_PLUGIN_DIR}
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs
COPY --from=runtime-assets --chown=node:node /app/qa ./qa

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

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES; \
    fi

ARG OPENCLAW_INSTALL_BROWSER=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright; \
    fi

ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg && \
      install -m 0755 -d /etc/apt/keyrings && \
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

ARG OPENCLAW_INSTALL_AZURE_CLI=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_AZURE_CLI" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg lsb-release && \
      mkdir -p /etc/apt/keyrings && \
      curl -sLS https://packages.microsoft.com/keys/microsoft.asc | \
        gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg && \
      chmod a+r /etc/apt/keyrings/microsoft.gpg && \
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/azure-cli.list && \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends azure-cli; \
    fi

RUN python3 -m venv /opt/skills-venv \
    && /opt/skills-venv/bin/pip install --no-cache-dir \
        websockets \
        composio

ENV PATH="/opt/skills-venv/bin:$PATH"

COPY --chown=node:node ./openclaw-team-workspace /app/agent-workspace

COPY ./templates/openclaw.template.json /opt/templates/openclaw.template.json
COPY ./templates/auth-profiles.template.json /opt/templates/auth-profiles.template.json
COPY ./templates/USER.template.md /opt/templates/USER.template.md

COPY ./scripts/openclaw-entrypoint.sh /usr/local/bin/openclaw-entrypoint.sh
RUN chmod +x /usr/local/bin/openclaw-entrypoint.sh

RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

RUN install -d -m 0700 -o node -g node /home/node/.openclaw /home/node/.outlook-mcp && \
    stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700' && \
    stat -c '%U:%G %a' /home/node/.outlook-mcp | grep -qx 'node:node 700'

RUN printf '%s\n' \
      'if (typeof globalThis.fetch === "function" && typeof globalThis.window === "undefined") {' \
      '  globalThis.window = { fetch: globalThis.fetch };' \
      '}' \
      > /home/node/.openclaw/gaxios-fix.cjs && \
    chown node:node /home/node/.openclaw/gaxios-fix.cjs && \
    chmod 600 /home/node/.openclaw/gaxios-fix.cjs

ENV NODE_ENV=production
ENV HOME=/home/node
ENV NODE_OPTIONS="--require /home/node/.openclaw/gaxios-fix.cjs"
ENV PATH="/usr/bin:/usr/local/bin:/opt/skills-venv/bin:$PATH"

USER node

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/openclaw-entrypoint.sh"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
