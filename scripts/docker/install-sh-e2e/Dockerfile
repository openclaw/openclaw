FROM node:22-bookworm-slim@sha256:3cfe526ec8dd62013b8843e8e5d4877e297b886e5aace4a59fec25dc20736e45

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

COPY run.sh /usr/local/bin/openclaw-install-e2e
RUN chmod +x /usr/local/bin/openclaw-install-e2e

ENTRYPOINT ["/usr/local/bin/openclaw-install-e2e"]
