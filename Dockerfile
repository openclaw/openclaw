# Build gogcli from source
FROM golang:1.25-bookworm AS gogcli-builder
RUN git clone https://github.com/steipete/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    GOOS=linux GOARCH=amd64 go build -o /tmp/gog-linux-amd64 ./cmd/gog

FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Install system dependencies for CLI tools
# - git: required by shopify CLI and slack CLI
# - python3/pip: general-purpose scripting
# - libasound2: required by sag (ElevenLabs TTS) and spotify-player (ALSA audio)
# - libssl3, libdbus-1-3: required by spotify-player
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git \
      python3 \
      python3-pip \
      python3-venv \
      libasound2 \
      libssl3 \
      libdbus-1-3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy Go toolchain (useful for building tools from source)
COPY --from=golang:1.25-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# Copy gogcli binary from builder stage
COPY --from=gogcli-builder /tmp/gog-linux-amd64 /usr/local/bin/gog

# Install pre-built CLI binaries
# himalaya (email via IMAP/SMTP)
RUN curl -fsSL https://github.com/pimalaya/himalaya/releases/download/v1.1.0/himalaya.x86_64-linux.tgz \
    | tar xz -C /usr/local/bin himalaya

# gh (GitHub CLI)
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.86.0/gh_2.86.0_linux_amd64.deb -o /tmp/gh.deb && \
    dpkg -i /tmp/gh.deb && \
    rm /tmp/gh.deb

# slack CLI (binary is at bin/slack inside the tarball)
RUN curl -fsSL https://github.com/slackapi/slack-cli/releases/download/v3.12.0/slack_cli_3.12.0_linux_64-bit.tar.gz \
    | tar xz --strip-components=1 -C /usr/local/bin bin/slack

# sag (ElevenLabs TTS)
RUN curl -fsSL https://github.com/steipete/sag/releases/download/v0.2.2/sag_0.2.2_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin sag

# spotify-player
RUN curl -fsSL https://github.com/aome510/spotify-player/releases/download/v0.21.3/spotify_player-x86_64-unknown-linux-gnu.tar.gz \
    | tar xz -C /usr/local/bin

# jira-cli (binary is at jira_1.7.0_linux_x86_64/bin/jira inside the tarball)
RUN curl -fsSL https://github.com/ankitpokhrel/jira-cli/releases/download/v1.7.0/jira_1.7.0_linux_x86_64.tar.gz \
    | tar xz --strip-components=2 -C /usr/local/bin jira_1.7.0_linux_x86_64/bin/jira

# Ensure all binaries are executable
RUN chmod +x /usr/local/bin/gog /usr/local/bin/himalaya /usr/local/bin/sag \
    /usr/local/bin/spotify_player /usr/local/bin/jira

# Install npm-based CLI tools
RUN npm install -g \
    trello-cli \
    @litencatt/notion-cli \
    vercel \
    @anthropic-ai/claude-code \
    @shopify/cli \
    mcporter

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after pnpm install so playwright-core is available in node_modules.
ARG OPENCLAW_INSTALL_BROWSER=""
RUN if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Configure runtime global install dirs on persistent volume (/data)
# so skills/tools installed at runtime persist across VM restarts
# and the non-root node user has write access.
ENV NPM_CONFIG_PREFIX="/data/npm-global"
ENV PNPM_HOME="/data/pnpm-global"
ENV GOPATH="/data/go"
ENV GOBIN="/data/go/bin"
ENV PATH="/data/npm-global/bin:/data/pnpm-global:/data/go/bin:${PATH}"

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Prepare Homebrew install dir with correct ownership before switching to node user
RUN mkdir -p /home/linuxbrew/.linuxbrew && chown -R node:node /home/linuxbrew

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Install Homebrew (Linuxbrew) as non-root node user
RUN NONINTERACTIVE=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && \
    /home/linuxbrew/.linuxbrew/bin/brew --version
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV PATH="${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:${PATH}"

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
