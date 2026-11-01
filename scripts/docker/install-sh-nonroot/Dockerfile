# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

# Smoke images are pinned and short-lived, so skip distro upgrades here and
# spend the time budget on installer coverage instead.
RUN --mount=type=cache,id=openclaw-install-sh-nonroot-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-nonroot-apt-lists,target=/var/lib/apt,sharing=locked \
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
    g++ \
    make \
    python3 \
    sudo

# Preinstall the supported Node runtime in a cacheable build layer so the
# non-root smoke covers user-local npm prefixing and missing git without paying
# the full NodeSource bootstrap cost on every container run.
RUN --mount=type=cache,id=openclaw-install-sh-nonroot-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-nonroot-apt-lists,target=/var/lib/apt,sharing=locked \
  set -eux; \
  installer="$(mktemp)"; \
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$installer" https://deb.nodesource.com/setup_24.x; \
  bash "$installer"; \
  rm -f "$installer"; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs

RUN useradd -m -s /bin/bash app \
  && echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/app

USER app
WORKDIR /home/app

ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh
COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 install-sh-nonroot/run.sh /usr/local/bin/openclaw-install-nonroot

ENTRYPOINT ["/usr/local/bin/openclaw-install-nonroot"]
