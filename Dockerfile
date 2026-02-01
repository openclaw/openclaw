FROM node:22-bookworm

# ----------------------------
# System dependencies
# ----------------------------
# Note: no golang-go here; Debian's Go is often behind and breaks go.mod "go 1.24.0"
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git bash build-essential procps file xz-utils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ----------------------------
# Go (upstream) - pinned, arch-aware
# ----------------------------
# Keep this pinned for reproducible builds.
ARG GO_VERSION=1.24.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) goarch="amd64" ;; \
      arm64) goarch="arm64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tgz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm -f /tmp/go.tgz; \
    /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}"

# ----------------------------
# Workspace ownership for non-root installs/builds
# ----------------------------
RUN mkdir -p /app && chown -R node:node /app
WORKDIR /app

# ----------------------------
# pnpm via corepack (must be root to link into /usr/local/bin)
# ----------------------------
RUN corepack enable && corepack prepare pnpm@latest --activate

# ----------------------------
# Bun to stable prefix + shims (/usr/local/bin) for PATH-sanitised subprocesses
# ----------------------------
RUN mkdir -p /opt/bun && chown -R node:node /opt/bun
USER node
ENV HOME=/home/node
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash

USER root
RUN ln -sf /opt/bun/bin/bun /usr/local/bin/bun && \
    ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx

# ----------------------------
# Homebrew (Linux default prefix) + shims
# ----------------------------
RUN mkdir -p /home/linuxbrew/.linuxbrew && chown -R node:node /home/linuxbrew
USER node
ENV NONINTERACTIVE=1
ENV HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew

RUN set -eux; \
    /bin/bash -lc "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash"; \
    test -f "${HOMEBREW_PREFIX}/Homebrew/Library/Homebrew/brew.sh"; \
    ln -sfn "${HOMEBREW_PREFIX}/Homebrew/Library" "${HOMEBREW_PREFIX}/Library"; \
    "${HOMEBREW_PREFIX}/bin/brew" --version

USER root
RUN ln -sf /home/linuxbrew/.linuxbrew/bin/brew /usr/local/bin/brew && \
    /usr/local/bin/brew --version

# Also expose brew on PATH (helpful for interactive shells; shims cover sanitised PATH)
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# ----------------------------
# pnpm global bin dir (stable)
# ----------------------------
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN mkdir -p "${PNPM_HOME}" && chown -R node:node "${PNPM_HOME}"

USER node
RUN pnpm config set global-bin-dir "${PNPM_HOME}"

# ----------------------------
# Dependencies install (cache-friendly)
# ----------------------------
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

RUN pnpm install --frozen-lockfile

# ----------------------------
# Build
# ----------------------------
COPY --chown=node:node . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build

ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
