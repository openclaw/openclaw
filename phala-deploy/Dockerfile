# --- Stage 1: Build gogcli (Google API CLI with env-var credential injection) ---
FROM golang:1.25-bookworm AS gogcli-builder
ARG GOGCLI_REPO=https://github.com/Leechael/gogcli.git
ARG GOGCLI_BRANCH=feat/env-token-injection
RUN git clone --depth 1 --branch "$GOGCLI_BRANCH" "$GOGCLI_REPO" /src/gogcli
WORKDIR /src/gogcli
RUN CGO_ENABLED=0 go build \
      -ldflags "-s -w \
        -X github.com/steipete/gogcli/internal/cmd.version=$(git describe --tags --always --dirty 2>/dev/null || echo dev) \
        -X github.com/steipete/gogcli/internal/cmd.commit=$(git rev-parse --short=12 HEAD) \
        -X github.com/steipete/gogcli/internal/cmd.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      -o /out/gog-bin ./cmd/gog

# --- Stage 2: Base prerequisites (system deps, no openclaw) ---
FROM ubuntu:24.04 AS base-prereqs

ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: System packages (Docker binaries installed below)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git bash tmux unzip lsof \
      iptables lsb-release sudo && \
    update-alternatives --set iptables /usr/sbin/iptables-legacy && \
    update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Docker static binaries + compose plugin (~80MB vs ~280MB for docker-ce)
ARG DOCKER_VERSION=27.5.1
ARG COMPOSE_VERSION=2.32.4
RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Layer 2: Node.js 24 via nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Layer 3: Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Layer 4: Linuxbrew (Homebrew)
RUN useradd -m -s /bin/bash linuxbrew && \
    echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
RUN NONINTERACTIVE=1 su - linuxbrew -c \
    'bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV PATH="${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:${PATH}"

# Layer 5: Shell environment
RUN echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /root/.bashrc && \
    echo 'export PATH="/root/.bun/bin:$PATH"' >> /root/.bashrc

# Layer 7: mcporter (MCP client CLI, used by composio skill)
RUN npm install -g mcporter && \
    rm -rf /root/.npm /tmp/*

# gogcli: static binary + credential-sourcing wrapper
COPY --from=gogcli-builder /out/gog-bin /usr/local/bin/gog-bin
COPY phala-deploy/gogcli/gog-wrapper.sh /usr/local/bin/gog
RUN chmod +x /usr/local/bin/gog /usr/local/bin/gog-bin

COPY phala-deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -so /dev/null http://localhost:18789/v1/mux/inbound || exit 1

ENTRYPOINT ["/entrypoint.sh"]

# --- Stage 3: Production base (openclaw from tarball) ---
FROM base-prereqs AS base

COPY phala-deploy/openclaw.tgz /tmp/openclaw.tgz
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    npm install -g /tmp/openclaw.tgz && \
    rm -f /tmp/openclaw.tgz && \
    apt-get purge -y --auto-remove build-essential && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* /usr/include

# --- Stage 4: Dev image (openclaw via bind mount) ---
FROM base-prereqs AS dev

RUN printf '#!/bin/sh\nexec node /app/openclaw.mjs "$@"\n' > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw

# --- Stage 5: Full image (standalone with SSH + S3 support) ---
FROM base AS full

# SSH daemon
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-server && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# rclone for encrypted S3 mount (single static binary, ~50MB)
ARG RCLONE_VERSION=1.73.0
RUN curl -fsSL "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" \
      -o /tmp/rclone.zip && \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin && \
    chmod +x /usr/local/bin/rclone && \
    rm /tmp/rclone.zip

# fuse3 for rclone mount
RUN apt-get update && \
    apt-get install -y --no-install-recommends fuse3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
