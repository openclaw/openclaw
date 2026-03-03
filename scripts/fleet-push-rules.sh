#!/bin/bash
set -euo pipefail

RULES_FILE="${1:-templates/security/policy-rules.yaml}"
CLIENTS_DIR="clients"

for client_dir in "$CLIENTS_DIR"/*/; do
  client_name=$(basename "$client_dir")
  [[ "$client_name" == "_template" ]] && continue
  
  config="$client_dir/client.yaml"
  [[ ! -f "$config" ]] && continue
  
  live=$(yq '.status.live' "$config" 2>/dev/null) || live="false"
  [[ "$live" != "true" ]] && continue
  
  ts_name=$(yq '.vps.tailscale_name' "$config" 2>/dev/null)
  [[ -z "$ts_name" ]] && continue
  
  echo "Pushing rules to $client_name ($ts_name)..."
  curl -s -X POST "http://${ts_name}:18790/api/rules" \
    -H "Content-Type: application/json" \
    -d "{\"layer\":\"client\",\"rulesYaml\":\"$(cat "$RULES_FILE" | base64 -w0)\"}" \
    && echo "  ✓ Success" || echo "  ✗ Failed"
done
