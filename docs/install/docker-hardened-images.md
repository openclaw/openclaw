---
summary: "Using Docker Hardened Images (DHI) for enhanced security"
read_when:
  - You want to reduce container vulnerabilities
  - You need compliance-ready base images
  - You're deploying to production
title: "Docker Hardened Images"
---

# Docker Hardened Images (DHI)

Docker Hardened Images (DHI) are minimal, security-focused base images maintained by Docker. They provide drop-in replacements for standard Node.js images with significantly reduced attack surface.

## What are DHI?

DHI are "distroless" container images that:

- Remove unnecessary components (shells, package managers, debugging tools)
- Reduce attack surface by up to 95%
- Include cryptographic signing and SBOMs
- Receive continuous security updates from Docker
- Support compliance frameworks (FIPS, STIG, CIS)

## Benefits for OpenClaw

- **Fewer vulnerabilities:** Near-zero CVEs vs standard images
- **Smaller images:** Reduced size and faster pulls
- **Supply chain security:** Signed with provenance attestations
- **Production-ready:** Designed for runtime, not development

## Using DHI with OpenClaw

### Gateway (Dockerfile)

Replace the standard Node.js base image with DHI:

```dockerfile
# Build stage - DHI with development tools
FROM dhi.io/node:22-debian12-dev AS builder

# Install Bun (required for build scripts)
# Note: Use your preferred Bun installation method with checksum verification
# See: https://bun.sh/docs/installation
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# ... existing build steps ...

# Production stage - DHI runtime-only
FROM dhi.io/node:22-debian12

WORKDIR /app

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/extensions ./extensions

ENV NODE_ENV=production

# Security hardening: Run as non-root user
USER node

CMD ["node", "dist/index.js"]
```

### Sandbox Images

For custom sandbox images, use DHI Python/Go/Rust variants:

```dockerfile
# Python sandbox
FROM dhi.io/python:3.12-debian12

# Go sandbox
FROM dhi.io/go:1.23-debian12

# Rust sandbox
FROM dhi.io/rust:1.77-debian12
```

## Available DHI Images

OpenClaw requires Node.js 22, which is available in DHI:

| Runtime           | DHI Tag                       | Use Case                  |
| ----------------- | ----------------------------- | ------------------------- |
| Node.js (dev)     | `dhi.io/node:22-debian12-dev` | Build stage               |
| Node.js (runtime) | `dhi.io/node:22-debian12`     | Production                |
| Python            | `dhi.io/python:3.12-debian12` | Python sandbox (optional) |
| Go                | `dhi.io/go:1.23-debian12`     | Go sandbox (optional)     |
| Rust              | `dhi.io/rust:1.77-debian12`   | Rust sandbox (optional)   |

See [Docker Hub DHI catalog](https://hub.docker.com/u/dhi) for all available images and versions.

## Considerations

### What's Removed (Distroless)

DHI **runtime** images don't include:

- Shell (bash, sh)
- Package managers (apt, apk)
- Debugging tools (curl, wget, git)

DHI **dev** images (e.g., `dhi.io/node:22-debian12-dev`) include build tools for the builder stage. Use multi-stage builds: install dependencies in the dev stage, copy artifacts to the minimal runtime stage.

### Debugging

Without a shell, debugging requires:

- `docker exec` won't work for interactive shells
- Use `docker logs` for output
- Add debugging tools in dev stage only
- Use `docker cp` to extract files

### Compatibility

DHI images are compatible with:

- Standard Docker commands
- Docker Compose
- Kubernetes
- All major container runtimes

## Migration Checklist

- [ ] Update Dockerfile to use DHI base images
- [ ] Implement multi-stage build (dev + runtime)
- [ ] Test build process locally
- [ ] Verify runtime behavior
- [ ] Update CI/CD pipelines
- [ ] Document any debugging changes

## Automated Rebuild Script

For convenience, you can use this script to rebuild OpenClaw with DHI from any version:

```bash
#!/bin/bash
# rebuild-dhi.sh - Rebuild OpenClaw with Docker Hardened Images

set -e

VERSION=${1:-"latest"}

echo "Rebuilding OpenClaw with DHI"
echo "Version: $VERSION"

# Checkout target version
if [ "$VERSION" = "latest" ]; then
    git checkout main && git pull
else
    git checkout "$VERSION"
fi

# Build with DHI
docker build -t openclaw:dhi -f Dockerfile .

# Verify
docker images openclaw:dhi
echo "Build complete"
```

Usage:

```bash
chmod +x rebuild-dhi.sh
./rebuild-dhi.sh latest        # Build from main
./rebuild-dhi.sh v2026.2.1     # Build from specific tag
```

## Resources

- [Docker Hardened Images Documentation](https://docs.docker.com/trusted-content/dhi/)
- [DHI on Docker Hub](https://hub.docker.com/u/dhi)
- [OpenClaw Docker Setup](/install/docker)
- [OpenClaw Sandboxing](/gateway/sandboxing)

## License

Docker Hardened Images are free and open source (Apache 2.0 license).
