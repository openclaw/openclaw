# Build stage
FROM node:22-bookworm AS builder

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

RUN corepack enable

# Copy config files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Cleanup: Prune dev dependencies and source files to save space
RUN CI=true pnpm prune --prod && \
  rm -rf src ui/src ui/node_modules

# Runtime stage
FROM node:22-bookworm-slim

WORKDIR /app

# Install Python and dependencies (Static layer)
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  ca-certificates \
  curl \
  wget \
  netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install --no-cache-dir tushare pandas matplotlib numpy --break-system-packages

# Install custom APT packages (Dynamic layer)
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
  rm -rf /var/lib/apt/lists/*; \
  fi

ENV NODE_ENV=production

# Copy built application from builder
COPY --from=builder /app /app

# Allow non-root user to write temp files
RUN chown -R node:node /app

# Security hardening
USER node

# Start gateway server
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
