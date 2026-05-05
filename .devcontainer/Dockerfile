# syntax=docker/dockerfile:1.7

# Development container for OpenClaw.
# Provides Node 22, pnpm, GitHub CLI, and Claude CLI on Debian bookworm.
# GitHub Copilot (gh extension) is installed by on-create.sh when auth
# is available. Works with Docker and Podman.

FROM node:22-bookworm

# Avoid interactive prompts during package install.
ENV DEBIAN_FRONTEND=noninteractive

# Install system utilities and GitHub CLI.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      lsof \
      make \
      g++ \
      python3 \
      openssh-client \
      procps && \
    # GitHub CLI
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    # Cleanup
    rm -rf /var/lib/apt/lists/*

# Enable corepack so pnpm is available without a separate global install.
RUN corepack enable

# Install Claude CLI globally.
RUN npm install -g @anthropic-ai/claude-code

# Switch to non-root user.
USER node
