FROM openclaw:local

USER root

# Enable low-risk bundled skills that depend on common CLI tools.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    jq \
    ripgrep \
    tmux \
    ffmpeg \
    gh \
 && rm -rf /var/lib/apt/lists/*

# Lobster plugin expects `lobster` CLI on PATH.
# Official plugin package currently provides no CLI binary,
# so we pin the compatible runtime package that ships `lobster`.
RUN npm install -g @clawdbot/lobster@2026.1.24 \
 && lobster version

# Install OpenCode CLI so the sidecar service can run without
# runtime package installation on every container start.
RUN npm install -g opencode-ai@1.2.10 \
 && opencode --version

USER node
