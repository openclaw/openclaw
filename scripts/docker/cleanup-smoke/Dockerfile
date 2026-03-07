FROM node:22-bookworm-slim@sha256:3cfe526ec8dd62013b8843e8e5d4877e297b886e5aace4a59fec25dc20736e45

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
