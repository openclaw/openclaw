#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

review_export_env
review_print_summary
echo "review_token=${REVIEW_GATEWAY_TOKEN}"
echo
if review_port_listening; then
  review_repo_cmd dashboard --no-open
else
  echo "Dashboard URL: ${REVIEW_BASE_URL}"
  echo "Gateway is not running. Start it with: bash scripts/review/${REVIEW_ID}/start.sh"
fi
