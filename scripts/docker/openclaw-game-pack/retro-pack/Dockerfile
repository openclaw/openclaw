# syntax=docker/dockerfile:1.7
FROM debian:bookworm-slim

ARG GAME_PACKAGES=""
ARG GAME_CMD=""

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV XVFB_WHD=1280x720x24
ENV NOVNC_PORT=6080
ENV VNC_PORT=5900
ENV GAME_CMD=${GAME_CMD}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tini \
      xvfb \
      fluxbox \
      x11vnc \
      novnc \
      websockify \
      x11-utils \
      fonts-dejavu \
      ca-certificates; \
    if [ -n "$GAME_PACKAGES" ]; then \
      apt-get install -y --no-install-recommends $GAME_PACKAGES; \
    fi; \
    rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 game \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/game --shell /usr/sbin/nologin game \
    && mkdir -p /games /tmp/runtime \
    && chown -R game:game /games /tmp/runtime /home/game

COPY retro-web-entrypoint.sh /usr/local/bin/retro-web-entrypoint
RUN chmod 0755 /usr/local/bin/retro-web-entrypoint

WORKDIR /games

ENV HOME=/home/game
ENV XDG_RUNTIME_DIR=/tmp/runtime

USER 10001:10001

EXPOSE 6080 5900

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/retro-web-entrypoint"]
