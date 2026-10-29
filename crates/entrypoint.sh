#!/bin/sh
# Container entrypoint: bootstrap config once, then run the Gateway.
#
# A fresh container has no config, and the Gateway refuses a non-loopback listener
# without auth, so starting it directly exits 1. Onboarding is also what pins the
# database path inside the mounted volume; the built-in default is relative and
# would write outside it.
set -eu

STATE_DIR="${OPENCLAW_STATE_DIR:-/var/lib/openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"

if [ ! -f "${CONFIG_PATH}" ]; then
    echo "==> No config at ${CONFIG_PATH}; running onboarding"
    /usr/local/bin/openclaw onboard
fi

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    echo "!! OPENCLAW_GATEWAY_TOKEN is empty." >&2
    echo "   A non-loopback Gateway will refuse to start. Set it in the container" >&2
    echo "   environment, or read the token onboarding wrote to ${CONFIG_PATH}." >&2
fi

exec /usr/local/bin/openclaw gateway \
    --config "${CONFIG_PATH}" \
    --listen 0.0.0.0:18789 \
    --dashboard 0.0.0.0:18790
