# Replace the placeholder with an immutable linux/amd64 digest from the official
# Docker Hub repository. Cloudflare Containers cannot pull OpenClaw from GHCR.
ARG OPENCLAW_IMAGE=openclaw/openclaw@sha256:<official-openclaw-image-digest>
FROM ${OPENCLAW_IMAGE} AS litestream

USER root

ARG LITESTREAM_VERSION=0.5.18
ARG LITESTREAM_SHA256=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea

ADD --checksum=sha256:${LITESTREAM_SHA256} \
  https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz \
  /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && chmod 0755 /usr/local/bin/litestream

FROM ${OPENCLAW_IMAGE}
USER root

# Copy only the binary so the download archive stays out of runtime layers.
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream

COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /usr/local/bin/cloudflare-entrypoint.sh
RUN chmod 0755 /usr/local/bin/cloudflare-entrypoint.sh \
  && chown root:root /etc/litestream.yml /usr/local/bin/cloudflare-entrypoint.sh

USER node
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/cloudflare-entrypoint.sh"]
