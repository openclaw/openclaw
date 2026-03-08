FROM node:22-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

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
    sudo \
  && rm -rf /var/lib/apt/lists/*

COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh
COPY install-sh-smoke/run.sh /usr/local/bin/openclaw-install-smoke
RUN chmod +x /usr/local/bin/openclaw-install-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-install-smoke"]
