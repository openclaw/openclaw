FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    openssh-client \
    unzip \
    xz-utils \
    zstd \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin openclaw

USER openclaw

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ffmpeg -version >/dev/null || exit 1
