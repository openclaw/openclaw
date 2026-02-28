FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (pinned binary + checksum verification).
# You can optionally pin architecture-specific SHA256 values at build time:
#   --build-arg BUN_SHA256_X64=<sha256> --build-arg BUN_SHA256_ARM64=<sha256>
ARG BUN_VERSION=1.2.21
ARG BUN_SHA256_X64=""
ARG BUN_SHA256_ARM64=""
RUN set -eux; \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unzip && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) bun_arch="x64"; bun_sha="${BUN_SHA256_X64}" ;; \
      arm64) bun_arch="aarch64"; bun_sha="${BUN_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture for Bun install: ${arch}"; exit 1 ;; \
    esac; \
    bun_asset="bun-linux-${bun_arch}.zip"; \
    bun_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_asset}"; \
    checksums_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt"; \
    curl -fsSLo /tmp/bun.zip "${bun_url}"; \
    if [ -n "${bun_sha}" ]; then \
      echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c -; \
    else \
      curl -fsSLo /tmp/bun-shasums.txt "${checksums_url}"; \
      grep " ${bun_asset}$" /tmp/bun-shasums.txt | sed "s|  ${bun_asset}$|  /tmp/bun.zip|" | sha256sum -c -; \
    fi; \
    mkdir -p /tmp/bun-install && \
    unzip -q /tmp/bun.zip -d /tmp/bun-install && \
    install -m 0755 "/tmp/bun-install/bun-linux-${bun_arch}/bun" /usr/local/bin/bun && \
    rm -rf /tmp/bun.zip /tmp/bun-shasums.txt /tmp/bun-install && \
    bun --version | grep -Fx "${BUN_VERSION}"
ENV PATH="/usr/local/bin:${PATH}"

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
USER root
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p /home/node/.cache/ms-playwright && \
      PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node /home/node/.cache/ms-playwright && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

USER node
COPY --chown=node:node . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Expose the CLI binary without requiring npm global writes as non-root.
USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

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
