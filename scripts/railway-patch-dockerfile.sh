#!/usr/bin/env bash
# Idempotently patch the OpenClaw Dockerfile for Railway compatibility.
# Single source of truth for the Railway-specific Dockerfile changes; called by
# .github/workflows/upstream-sync.yml after merging a new upstream release, and
# mirrors the logic in .github/workflows/railway-compat.yml. Safe to run twice.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f Dockerfile ] || { echo "no Dockerfile, nothing to patch"; exit 0; }

# 1) Strip BuildKit cache mounts — Railway's builder does not support them.
if grep -q '\-\-mount=type=cache' Dockerfile; then
  sed -i 's/ *--mount=type=cache[^ ]* *\\\?//g' Dockerfile
  sed -i '/^RUN \\$/d' Dockerfile
  sed -i '/^[[:space:]]*\\$/d' Dockerfile
  echo "patched: stripped BuildKit cache mounts"
fi

# 2) PaaS gateway config — host-header origin fallback for the Control UI.
if ! grep -q 'dangerouslyAllowHostHeaderOriginFallback' Dockerfile; then
  sed -i '/^USER node$/i \
# PaaS gateway config: allow host-header origin fallback for the Control UI\
# since Railway\/Render\/Fly proxy traffic through their own domains.\
RUN mkdir -p \/app\/.openclaw \&\& \\\
    printf '"'"'{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}}}\\n'"'"' \\\
      > \/app\/.openclaw\/openclaw.json \&\& \\\
    chown -R node:node \/app\/.openclaw\
ENV OPENCLAW_CONFIG_PATH=\/app\/.openclaw\/openclaw.json\
' Dockerfile
  echo "patched: restored PaaS gateway config"
fi

# 3) Railway-compatible HEALTHCHECK + CMD — honor $PORT and bind to lan (0.0.0.0).
sed -i '/^HEALTHCHECK/,/CMD node/{
  s|CMD node -e "fetch(.http://127.0.0.1:18789/healthz.).*|CMD node -e "const p=process.env.PORT\|\|18789;fetch('"'"'http://127.0.0.1:'"'"'+p+'"'"'/healthz'"'"').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"|
}' Dockerfile
sed -i 's|^CMD \["node", "openclaw.mjs", "gateway", "--allow-unconfigured"\]|CMD ["sh", "-c", "exec node --max-old-space-size=4096 openclaw.mjs gateway --bind lan --port ${PORT:-18789} --allow-unconfigured"]|' Dockerfile
echo "patched: ensured Railway-compatible CMD and HEALTHCHECK"
