FROM node:22-bookworm-slim@sha256:3cfe526ec8dd62013b8843e8e5d4877e297b886e5aace4a59fec25dc20736e45

RUN set -eux; \
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

COPY run.sh /usr/local/bin/openclaw-install-smoke
RUN chmod +x /usr/local/bin/openclaw-install-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-install-smoke"]
