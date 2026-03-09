# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim@sha256:3cfe526ec8dd62013b8843e8e5d4877e297b886e5aace4a59fec25dc20736e45

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
