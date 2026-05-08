# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb

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
    sudo \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /bin/bash openclaw \
  && echo "openclaw ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/openclaw \
  && chmod 0440 /etc/sudoers.d/openclaw

COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh
COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 install-sh-smoke/run.sh /usr/local/bin/openclaw-install-smoke

USER openclaw

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --version >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/openclaw-install-smoke"]
