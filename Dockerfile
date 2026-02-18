FROM node:22-bookworm as homebrew-builder

# Install dependencies
RUN apt-get update && apt-get install -y curl git file && rm -rf /var/lib/apt/lists/*

# Create linuxbrew user for Homebrew installation
RUN useradd -m -s /bin/bash linuxbrew && \
    mkdir -p /home/linuxbrew/.linuxbrew && \
    chown -R linuxbrew:linuxbrew /home/linuxbrew

# Install Homebrew as linuxbrew user
USER linuxbrew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install gogcli and goplaces via Homebrew
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
RUN eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    brew tap steipete/tap && \
    brew install gogcli goplaces

# Verify binaries work
RUN eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && \
    gog --version && \
    goplaces --version

USER root

# Final stage
FROM node:22-bookworm

# Copy entire Homebrew installation
COPY --from=homebrew-builder /home/linuxbrew/.linuxbrew /home/linuxbrew/.linuxbrew

# Install runtime dependencies
RUN apt-get update && apt-get install -y socat git file && rm -rf /var/lib/apt/lists/*

# Set up Homebrew environment
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_NO_AUTO_UPDATE=1
ENV HOMEBREW_NO_ANALYTICS=1

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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Optionally install Chromium and Xvfb for browser automation.
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
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Configure npm for node user (install packages to user directory, not system)
RUN mkdir -p /home/node/.npm-global && \
    chown -R node:node /home/node/.npm-global

# Change ownership of Homebrew directories to node user for runtime installs
RUN chown -R node:node /home/linuxbrew/.linuxbrew /app /usr/local/lib/node_modules 2>/dev/null || true

USER node

# Set npm to use user directory for global installs
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
