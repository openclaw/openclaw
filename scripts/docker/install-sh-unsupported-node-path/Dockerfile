FROM ubuntu:24.04

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
    jq \
  && rm -rf /var/lib/apt/lists/*

COPY run.sh /usr/local/bin/openclaw-install-unsupported-node-path
RUN chmod +x /usr/local/bin/openclaw-install-unsupported-node-path

ENTRYPOINT ["/usr/local/bin/openclaw-install-unsupported-node-path"]
