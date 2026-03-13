# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:b4687aef2571c632a1953695ce4d61d6462a7eda471fe6e272eebf0418f276ba

RUN --mount=type=cache,id=openclaw-install-sh-e2e-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-e2e-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git

COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 run.sh /usr/local/bin/openclaw-install-e2e

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

ENTRYPOINT ["/usr/local/bin/openclaw-install-e2e"]
