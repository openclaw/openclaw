# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim@sha256:74d56e3931e0d5a1dd51f8c8a2466d21de84a271cd3b5a733b803aa91abf4421

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,id=openclaw-sandbox-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-sandbox-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    fonts-noto-color-emoji \
    git \
    jq \
    novnc \
    python3 \
    socat \
    websockify \
    x11vnc \
    xvfb

COPY --chmod=755 scripts/sandbox-browser-entrypoint.sh /usr/local/bin/openclaw-sandbox-browser

RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox

EXPOSE 9222 5900 6080

CMD ["openclaw-sandbox-browser"]
