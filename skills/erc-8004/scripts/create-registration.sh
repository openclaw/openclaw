#!/bin/bash
# ERC-8004 - Create agent registration JSON file
# Usage: ./create-registration.sh [output-file]
# 
# Environment variables:
#   AGENT_NAME - Agent display name (default: uses wallet address)
#   AGENT_DESCRIPTION - Agent description
#   AGENT_IMAGE - Avatar URL
#   AGENT_WEBSITE - Agent website
#   AGENT_A2A_ENDPOINT - A2A agent card URL
#   AGENT_MCP_ENDPOINT - MCP server endpoint
#   AGENT_ENS - ENS name
#   X402_SUPPORT - Enable x402 payments (true/false, default: false)

set -e

OUTPUT_FILE="${1:-/tmp/agent-registration.json}"

# Default values
NAME="${AGENT_NAME:-AI Agent}"
DESCRIPTION="${AGENT_DESCRIPTION:-An autonomous AI agent registered on ERC-8004}"
IMAGE="${AGENT_IMAGE:-}"
WEBSITE="${AGENT_WEBSITE:-}"
A2A_ENDPOINT="${AGENT_A2A_ENDPOINT:-}"
MCP_ENDPOINT="${AGENT_MCP_ENDPOINT:-}"
ENS="${AGENT_ENS:-}"
X402="${X402_SUPPORT:-false}"

echo "=== Creating Registration File ===" >&2
echo "Name: $NAME" >&2
echo "Description: $DESCRIPTION" >&2
echo "Output: $OUTPUT_FILE" >&2

# Build services array
SERVICES="[]"

if [ -n "$WEBSITE" ]; then
  SERVICES=$(echo "$SERVICES" | jq --arg url "$WEBSITE" '. + [{"name": "web", "endpoint": $url}]')
fi

if [ -n "$A2A_ENDPOINT" ]; then
  SERVICES=$(echo "$SERVICES" | jq --arg url "$A2A_ENDPOINT" '. + [{"name": "A2A", "endpoint": $url, "version": "0.3.0"}]')
fi

if [ -n "$MCP_ENDPOINT" ]; then
  SERVICES=$(echo "$SERVICES" | jq --arg url "$MCP_ENDPOINT" '. + [{"name": "MCP", "endpoint": $url, "version": "2025-06-18"}]')
fi

if [ -n "$ENS" ]; then
  SERVICES=$(echo "$SERVICES" | jq --arg ens "$ENS" '. + [{"name": "ENS", "endpoint": $ens, "version": "v1"}]')
fi

# Create registration file
cat > "$OUTPUT_FILE" << EOF
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "$NAME",
  "description": "$DESCRIPTION",
  "image": "$IMAGE",
  "services": $SERVICES,
  "x402Support": $X402,
  "active": true,
  "registrations": [],
  "supportedTrust": ["reputation"]
}
EOF

echo "=== SUCCESS ===" >&2
echo "Created: $OUTPUT_FILE" >&2
cat "$OUTPUT_FILE" >&2

echo "$OUTPUT_FILE"
