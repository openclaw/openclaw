# Dockerfile Patterns

## Multi-Stage Build (Node.js)

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Multi-Stage Build (Go)

```dockerfile
# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server

# Production stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/server /server
EXPOSE 8080
CMD ["/server"]
```

## Multi-Stage Build (Python)

```dockerfile
# Build stage
FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install --no-cache-dir poetry
COPY pyproject.toml poetry.lock ./
RUN poetry export -f requirements.txt -o requirements.txt

# Production stage
FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0"]
```

## Development vs Production

```dockerfile
# Base stage
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

# Development
FROM base AS development
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]

# Production
FROM base AS production
RUN npm ci --only=production
COPY . .
CMD ["npm", "start"]
```

## Non-Root User

```dockerfile
FROM node:20-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

COPY --chown=appuser:appgroup . .
USER appuser

CMD ["node", "index.js"]
```

## Health Check

```dockerfile
FROM nginx:alpine
COPY . /usr/share/nginx/html

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1
```

## Build Arguments & Environment

```dockerfile
FROM node:20-alpine

# Build-time argument
ARG NODE_ENV=production
ARG APP_VERSION=unknown

# Runtime environment variable
ENV NODE_ENV=${NODE_ENV}
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app
COPY . .
RUN npm ci

# Labels for metadata
LABEL org.opencontainers.image.version=${APP_VERSION}
LABEL org.opencontainers.image.source="https://github.com/owner/repo"

CMD ["node", "index.js"]
```

## .dockerignore

```
# Dependencies
node_modules
vendor
__pycache__

# Build artifacts
dist
build
*.egg-info

# Development
.git
.gitignore
.env
.env.*
*.md
docs/
tests/
*.test.js
*.spec.js

# IDE
.vscode
.idea
*.swp

# OS
.DS_Store
Thumbs.db

# Docker
Dockerfile*
docker-compose*
.dockerignore
```
