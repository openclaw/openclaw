#!/bin/bash
set -e

# Railway sets PORT, but openclaw expects OPENCLAW_GATEWAY_PORT or CLAWDBOT_GATEWAY_PORT
# Map Railway's PORT to OPENCLAW_GATEWAY_PORT if not already set
if [ -n "$PORT" ] && [ -z "$OPENCLAW_GATEWAY_PORT" ] && [ -z "$CLAWDBOT_GATEWAY_PORT" ]; then
  export OPENCLAW_GATEWAY_PORT="$PORT"
fi

# Default to 8080 if no port is set
: "${OPENCLAW_GATEWAY_PORT:=8080}"

# Run the gateway server
exec node openclaw.mjs gateway run --bind 0.0.0.0 --port "$OPENCLAW_GATEWAY_PORT"
