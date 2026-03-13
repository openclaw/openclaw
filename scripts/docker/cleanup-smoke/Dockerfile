# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:b4687aef2571c632a1953695ce4d61d6462a7eda471fe6e272eebf0418f276ba

RUN --mount=type=cache,id=openclaw-cleanup-smoke-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-cleanup-smoke-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
  corepack enable \
  && pnpm install --frozen-lockfile

COPY . .
COPY --chmod=755 scripts/docker/cleanup-smoke/run.sh /usr/local/bin/openclaw-cleanup-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-cleanup-smoke"]
