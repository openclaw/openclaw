#!/bin/bash
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
mkdir -p "$STATE_DIR"

if [ ! -f "$STATE_DIR/openclaw.json" ]; then
  cat > "$STATE_DIR/openclaw.json" <<'EOF'
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  }
}
EOF
fi

exec node openclaw.mjs gateway \
  --allow-unconfigured \
  --bind lan \
  --port "${PORT:-8080}"
