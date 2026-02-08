#!/bin/bash
# List all available agent sessions via Gateway.
# Usage: session-list.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/gateway-rpc.mjs" sessions.list
