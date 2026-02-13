# Use the base image
FROM node:22-bookworm

# 1. Setup PATH and Environment Variables
ENV PATH="/root/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV NODE_ENV=production
ENV OPENCLAW_PREFER_PNPM=1

# 2. Install System Dependencies, GitHub CLI, and 1Password CLI
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl file git procps sudo gnupg jq ripgrep && \
    # Add GitHub CLI Repo
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    # Add 1Password CLI Repo
    curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | tee /etc/apt/sources.list.d/1password.list && \
    # Add Docker CLI Repo
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    # Install the tools
    apt-get update && apt-get install -y gh 1password-cli docker-ce-cli && \
    # Install Bun
    curl -fsSL https://bun.sh/install | bash && \
    # Cleanup
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 3. Setup Homebrew (Switch to node user)
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER node
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install tools via Brew
RUN brew install steipete/tap/gogcli uv

# Install ClawHub CLI globally
USER root
RUN npm install -g clawhub

# 4. OpenClaw Build Process
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
RUN pnpm ui:build

# 5. Final Permissions
RUN chown -R node:node /app
USER node

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
