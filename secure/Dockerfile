# AssureBot - Minimal Docker Image
# Lean, secure, self-hosted AI assistant for Railway

FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config and package files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY secure/package.json ./secure/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source
COPY secure/ ./secure/

# Build TypeScript
RUN cd secure && pnpm exec tsc

# Production image
FROM node:22-slim AS runner

# Security: Run as non-root user
RUN useradd -m -u 1000 -s /bin/bash assurebot
USER assurebot

WORKDIR /app

# Copy built files and production deps
COPY --from=builder --chown=assurebot:assurebot /app/node_modules ./node_modules
COPY --from=builder --chown=assurebot:assurebot /app/secure/node_modules ./secure/node_modules
COPY --from=builder --chown=assurebot:assurebot /app/secure/dist ./dist
COPY --from=builder --chown=assurebot:assurebot /app/secure/package.json ./

# Create data directory for audit logs
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1))" || exit 1

CMD ["node", "dist/index.js"]
