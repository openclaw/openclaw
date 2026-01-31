#!/bin/bash
# Open the openclaw dashboard with the gateway token

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

source "$ENV_FILE"

if [[ -z "$OPENCLAW_GATEWAY_TOKEN" ]]; then
  echo "Error: OPENCLAW_GATEWAY_TOKEN not set in .env" >&2
  exit 1
fi

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
URL="http://localhost:${PORT}/chat?session=main&token=${OPENCLAW_GATEWAY_TOKEN}"

echo "Opening: $URL"
open "$URL"
