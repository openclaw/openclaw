# syntax=docker/dockerfile:1.27.1

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# Smoke images are pinned and short-lived, so skip distro upgrades here and
# spend the time budget on installer coverage instead.
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
