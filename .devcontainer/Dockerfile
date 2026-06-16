# Development container for OpenClaw.
# Based on the Microsoft Node 22 devcontainer image.
# Pre-installs GitHub CLI and Claude CLI so that devcontainer features
# are not needed (features require `buildx` and break with remote Podman).

FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# Install GitHub CLI.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally.
RUN npm install -g @anthropic-ai/claude-code

# Enable corepack so pnpm is available.
RUN corepack enable
