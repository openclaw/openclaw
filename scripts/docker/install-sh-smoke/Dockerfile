# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim@sha256:3cfe526ec8dd62013b8843e8e5d4877e297b886e5aace4a59fec25dc20736e45

RUN --mount=type=cache,id=openclaw-install-sh-smoke-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-smoke-apt-lists,target=/var/lib/apt,sharing=locked \
  set -eux; \
  for attempt in 1 2 3; do \
    if apt-get update -o Acquire::Retries=3; then break; fi; \
    echo "apt-get update failed (attempt ${attempt})" >&2; \
    if [ "${attempt}" -eq 3 ]; then exit 1; fi; \
    sleep 3; \
  done; \
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    g++ \
    make \
    python3 \
    sudo

COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh
COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 install-sh-smoke/run.sh /usr/local/bin/openclaw-install-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-install-smoke"]
