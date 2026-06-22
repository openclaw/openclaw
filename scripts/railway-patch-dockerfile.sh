#!/usr/bin/env bash
# Railway compatibility for the OpenClaw Dockerfile.
#
# Railway's builder is BuildKit-based and supports cache AND bind mounts, so we
# DO NOT strip mounts anymore (that was the old breakage). We append, as a
# marker-guarded block at the END of the file (so it survives any upstream
# Dockerfile restructure):
#   1. the PaaS Control UI config (host-header fallback + skip device auth), and
#   2. a root entrypoint that chowns the root-owned Railway volume, then drops to
#      the node user to start the gateway on $PORT.
# Safe to run repeatedly (guarded by the marker).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f Dockerfile ] || { echo "no Dockerfile, nothing to patch"; exit 0; }

MARKER_START="# >>> railway-paas-control-ui >>>"
if grep -qF "$MARKER_START" Dockerfile; then
  echo "patched: Railway block already present (idempotent no-op)"
  exit 0
fi

cat >> Dockerfile <<'BLOCK'

# >>> railway-paas-control-ui >>>
# Railway/Render/Fly proxy traffic through their own domains, so allow the
# Control UI host-header origin fallback and skip device auth. Appended by
# scripts/railway-patch-dockerfile.sh (marker-guarded; safe to re-run).
USER root
RUN mkdir -p /app/.openclaw \
 && printf '{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}}}\n' > /app/.openclaw/openclaw.json \
 && chown -R node:node /app/.openclaw
ENV OPENCLAW_CONFIG_PATH=/app/.openclaw/openclaw.json
# Railway volumes mount root-owned; this entrypoint (run as root) chowns the
# mounted state dir, then drops to the unprivileged node user to start the gateway.
COPY scripts/railway-entrypoint.sh /usr/local/bin/railway-entrypoint.sh
RUN chmod +x /usr/local/bin/railway-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/railway-entrypoint.sh"]
CMD []
# <<< railway-paas-control-ui <<<
BLOCK
echo "patched: appended Railway PaaS config + volume-perms entrypoint"
