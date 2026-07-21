# Mythos-Class OpenClaw Docker Deployment
# Multi-stage build with Rust native engines

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1: Rust build for native Mythos engines
# ═══════════════════════════════════════════════════════════════════════════════
FROM rust:1.75-slim-bookworm AS rust-builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Rust workspace
WORKDIR /build
COPY crates/ ./crates/

# Build all Mythos native engines in release mode
WORKDIR /build/crates
RUN cargo build --release --workspace

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2: TypeScript build
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS ts-builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /build

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig*.json ./
COPY tsdown.config.ts ./

# Copy source
COPY src/ ./src/
COPY extensions/ ./extensions/
COPY packages/ ./packages/
COPY ui/ ./ui/
COPY scripts/ ./scripts/

# Copy Rust build artifacts
COPY --from=rust-builder /build/crates/target/release/*.so ./crates/target/release/
COPY --from=rust-builder /build/crates/target/release/*.node ./crates/target/release/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build TypeScript
RUN pnpm build

# Build UI
RUN pnpm ui:build

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 3: Production runtime
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash openclaw

WORKDIR /home/openclaw

# Copy built artifacts
COPY --from=ts-builder --chown=openclaw:openclaw /build/dist ./dist
COPY --from=ts-builder --chown=openclaw:openclaw /build/ui/dist ./ui/dist
COPY --from=ts-builder --chown=openclaw:openclaw /build/node_modules ./node_modules
COPY --from=ts-builder --chown=openclaw:openclaw /build/package.json ./

# Copy Mythos workspace
COPY --chown=openclaw:openclaw mythos-workspace/ ./mythos-workspace/

# Copy skills
COPY --chown=openclaw:openclaw skills/ ./skills/

# Copy documentation
COPY --chown=openclaw:openclaw docs/ ./docs/
COPY --chown=openclaw:openclaw README.md LICENSE ./

# Switch to non-root user
USER openclaw

# Create data directories
RUN mkdir -p .openclaw/memory \
    .openclaw/sessions \
    .openclaw/logs \
    mythos-workspace/shared/wiki \
    mythos-workspace/shared/audit

# Environment variables
ENV NODE_ENV=production
ENV OPENCLAW_GATEWAY_PORT=18789
ENV OPENCLAW_CANVAS_PORT=18793

# Expose ports
EXPOSE 18789  # Gateway
EXPOSE 18793  # Canvas

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:18789/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command: start gateway
CMD ["node", "dist/index.js", "gateway", "--bind", "0.0.0.0", "--port", "18789"]

# ═══════════════════════════════════════════════════════════════════════════════
# Labels
# ═══════════════════════════════════════════════════════════════════════════════
LABEL org.opencontainers.image.title="Mythos-Class OpenClaw"
LABEL org.opencontainers.image.description="OpenClaw with Rust-accelerated Mythos engines"
LABEL org.opencontainers.image.version="2026.5.10-mythos"
LABEL org.opencontainers.image.vendor="OpenClaw"
LABEL org.opencontainers.image.licenses="MIT"
