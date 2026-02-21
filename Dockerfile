FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

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
RUN pnpm install --frozen-lockfile

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

ENV NODE_ENV=production

# Kaspar's custom tools (critical for Sparky functionality)
USER root

# GitHub CLI
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_amd64.tar.gz | \
    tar -xz --strip-components=1 -C /tmp && \
    mv /tmp/bin/gh /usr/local/bin/gh && \
    chmod +x /usr/local/bin/gh && \
    rm -rf /tmp/bin /tmp/etc

# Gmail CLI (gogcli)
RUN curl -fsSL https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz | \
    tar -xz -C /tmp && \
    mv /tmp/gog /usr/local/bin/gog && \
    chmod +x /usr/local/bin/gog && \
    rm -rf /tmp/gog /tmp/CHANGELOG.md /tmp/LICENSE /tmp/README.md

# Google Places CLI (goplaces)
RUN curl -fsSL https://github.com/steipete/goplaces/releases/download/v0.2.1/goplaces_0.2.1_linux_amd64.tar.gz | \
    tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Chrome/Playwright deps for headless browser screenshots (Sparky + Scout)
# These MUST be in the Dockerfile so they survive container rebuilds
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-client \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 \
    libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libdrm2 libpango-1.0-0 \
    libcairo2 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
USER node

# Install Playwright Chromium browser (as node user so paths are correct)
RUN cd /app && node node_modules/playwright-core/cli.js install chromium

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
