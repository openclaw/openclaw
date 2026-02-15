FROM node:22-bookworm

ARG BUN_VERSION=1.3.9

# Install Bun (required for build scripts) from a pinned release artifact.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) bun_arch="x64" ;; \
      arm64) bun_arch="aarch64" ;; \
      *) echo "Unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    bun_zip="bun-linux-${bun_arch}.zip"; \
    base_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"; \
    curl -fsSL "${base_url}/${bun_zip}" -o "/tmp/${bun_zip}"; \
    curl -fsSL "${base_url}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
    grep " ${bun_zip}$" /tmp/SHASUMS256.txt | sha256sum -c -; \
    unzip -p "/tmp/${bun_zip}" "bun-linux-${bun_arch}/bun" \
      > /usr/local/bin/bun; \
    chmod +x /usr/local/bin/bun; \
    rm -f "/tmp/${bun_zip}" /tmp/SHASUMS256.txt; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

ENV BUN_VERSION=${BUN_VERSION}

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

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD node openclaw.mjs gateway call health --json --timeout 8000 > /dev/null || exit 1

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
