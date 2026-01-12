FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    sudo \
  && rm -rf /var/lib/apt/lists/*

COPY run.sh /usr/local/bin/clawdbot-install-smoke
RUN chmod +x /usr/local/bin/clawdbot-install-smoke

ENTRYPOINT ["/usr/local/bin/clawdbot-install-smoke"]
