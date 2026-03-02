FROM node:22-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && pnpm install --frozen-lockfile

COPY . .
COPY scripts/docker/cleanup-smoke/run.sh /usr/local/bin/openclaw-cleanup-smoke
RUN chmod +x /usr/local/bin/openclaw-cleanup-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-cleanup-smoke"]
