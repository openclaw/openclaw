# syntax=docker/dockerfile:1.27.0

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN --mount=type=cache,id=openclaw-cleanup-smoke-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-cleanup-smoke-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY node-version.mjs ./
COPY node-sqlite.mjs ./
COPY node-runtime-update.mjs ./
COPY node-runtime-recovery.mjs ./
COPY node-compile-cache.mjs ./
COPY cli-root-options.mjs gateway-run-argv.mjs gateway-shutdown-budget.mjs ./
COPY node-host-launcher.mjs ./
COPY ui/package.json ./ui/package.json
COPY packages ./packages
COPY extensions ./extensions
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/prepare-git-hooks.mjs scripts/windows-cmd-helpers.mjs scripts/check-install-dependency-ownership.mjs ./scripts/
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs
COPY scripts/lib/javascript-statements.mjs ./scripts/lib/javascript-statements.mjs
COPY scripts/lib/package-lifecycle-marker.mjs ./scripts/lib/package-lifecycle-marker.mjs
COPY scripts/lib/fs-safe-prebuild.mjs ./scripts/lib/fs-safe-prebuild.mjs
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
  corepack enable \
  && if ! pnpm install --frozen-lockfile >/tmp/openclaw-cleanup-pnpm-install.log 2>&1; then \
    cat /tmp/openclaw-cleanup-pnpm-install.log; \
    exit 1; \
  fi

COPY . .
COPY --chmod=755 scripts/docker/cleanup-smoke/run.sh /usr/local/bin/openclaw-cleanup-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-cleanup-smoke"]
