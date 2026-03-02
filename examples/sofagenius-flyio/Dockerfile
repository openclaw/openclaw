# OpenClaw + SofaGenius API Bridge Dockerfile
# Runs both OpenClaw gateway and SofaGenius FastAPI backend on the same container.
#
# SofaGenius stays intact as its own project — OpenClaw talks to it via HTTP.
# Update SofaGenius independently; OpenClaw skills just forward API calls.

FROM node:22-bookworm

# -- System deps --
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git curl ca-certificates supervisor \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -- Python ML packages (SofaGenius deps) --
RUN python3 -m pip install --break-system-packages \
      fastapi uvicorn httpx \
      anthropic \
      wandb \
      huggingface_hub \
      modal \
      duckdb \
      Pillow

# -- Install Bun (required for OpenClaw build) --
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

# -- OpenClaw build --
WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

USER root
USER node
COPY --chown=node:node . .
RUN for dir in /app/extensions /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

# -- SofaGenius clone (pulled at build time, update with rebuild) --
RUN git clone https://github.com/lilyzhng/SofaGenius.git /opt/sofagenius \
 && cd /opt/sofagenius/backend \
 && python3 -m pip install --break-system-packages -r requirements.txt 2>/dev/null || true
RUN chown -R node:node /opt/sofagenius

# -- Supervisor config (runs both services) --
COPY examples/sofagenius-flyio/supervisord.conf /etc/supervisor/conf.d/openclaw-sofagenius.conf

ENV NODE_ENV=production

# Expose OpenClaw gateway (3000) and SofaGenius API (8000)
EXPOSE 3000 8000

# Supervisor manages both processes
CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/openclaw-sofagenius.conf"]
