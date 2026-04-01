# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (production flag doesn't work properly with npm ci)
RUN npm ci && \
    npm cache clean --force

# Copy pre-built application and source
COPY --chown=nodejs:nodejs build ./build
COPY --chown=nodejs:nodejs src ./src

# Switch to non-root user
USER nodejs

# Expose HTTP port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8081/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default to HTTP mode
CMD ["node", "build/index-http.js"]