#!/bin/sh
# Cloud Run entrypoint for OpenClaw Gateway.
#
# Cloud Run sets the PORT env var dynamically. The gateway reads
# OPENCLAW_GATEWAY_PORT (not PORT), so this script bridges the two
# via the --port CLI flag.

exec node dist/index.js gateway \
  --allow-unconfigured \
  --bind lan \
  --port "${PORT:-8080}"
