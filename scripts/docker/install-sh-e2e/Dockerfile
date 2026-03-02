FROM node:22-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

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
