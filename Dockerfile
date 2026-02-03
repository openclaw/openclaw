# Multi-stage build for OpenClaw Docker image
# Stage 1: Builder
FROM node:22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Stage 2: Runtime
FROM node:22-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    git \
    curl \
    tzdata \
    ca-certificates

# Copy OpenClaw from builder
COPY --from=builder /usr/local/lib/node_modules/openclaw /usr/local/lib/node_modules/openclaw
COPY --from=builder /usr/local/bin/openclaw /usr/local/bin/openclaw

# Create symbolic link for gateway
RUN ln -sf /usr/local/lib/node_modules/openclaw/dist/index.js /usr/local/bin/openclaw

# Setup directories
RUN mkdir -p /root/.openclaw /workspace

# Set working directory
WORKDIR /workspace

# Volume mount points
VOLUME ["/root/.openclaw", "/workspace"]

# Environment defaults
ENV GATEWAY_MODE=local \
    GATEWAY_BIND=0.0.0.0 \
    GATEWAY_PORT=18789 \
    OPENCLAW_MODEL=zhipu/GLM-4.7 \
    NODE_ENV=production

# Expose Gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:18789/health || exit 1

# Run Gateway by default
CMD ["gateway"]
