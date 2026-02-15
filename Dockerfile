FROM node:22-bookworm

# Map container user/group IDs to the host (for bind-mounted volumes).
# Defaults match the upstream node image user (uid/gid 1000).
ARG OPENCLAW_UID=1000
ARG OPENCLAW_GID=1000

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Prepend the mounted OpenClaw state bin so persisted tool shims (agent-installed) are discoverable.
ENV PATH="/home/node/.openclaw/bin:${PATH}"

# Map the built-in `node` user/group to the host UID/GID, then ensure /app is writable.
RUN set -eu; \
    case "${OPENCLAW_GID}" in (""|*[!0-9]*|0) ;; (*) \
      grp="$(getent group "${OPENCLAW_GID}" 2>/dev/null | cut -d: -f1 || true)"; \
      if [ -n "$grp" ] && [ "$grp" != node ]; then \
        echo "OPENCLAW_GID ${OPENCLAW_GID} already used by ${grp}; choose a different GID" >&2; exit 1; \
      fi; \
      if [ -z "$grp" ]; then \
        usermod -g root node; \
        groupmod -g "${OPENCLAW_GID}" node; \
        usermod -g node node; \
      fi ;; \
    esac; \
    case "${OPENCLAW_UID}" in (""|*[!0-9]*|0) ;; (*) \
      usr="$(getent passwd "${OPENCLAW_UID}" 2>/dev/null | cut -d: -f1 || true)"; \
      if [ -n "$usr" ] && [ "$usr" != node ]; then \
        echo "OPENCLAW_UID ${OPENCLAW_UID} already used by ${usr}; choose a different UID" >&2; exit 1; \
      fi; \
      if [ -z "$usr" ] || [ "$usr" = node ]; then usermod -u "${OPENCLAW_UID}" node; fi ;; \
    esac; \
    chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
