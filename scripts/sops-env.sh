#!/usr/bin/env bash
# Decrypt .env.enc → load into environment → run command
# Usage: ./scripts/sops-env.sh node dist/server.js
#        ./scripts/sops-env.sh pnpm dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENC_FILE="$PROJECT_DIR/.env.enc"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

if [ ! -f "$ENC_FILE" ]; then
  echo "Error: $ENC_FILE not found" >&2
  exit 1
fi

if ! command -v sops &>/dev/null; then
  echo "Error: sops not found — install via 'brew install sops' or https://github.com/getsops/sops" >&2
  exit 1
fi

# Decrypt and export all env vars
set -a
eval "$(sops -d --input-type dotenv --output-type dotenv "$ENC_FILE")"
set +a

echo "✓ Loaded $(sops -d --input-type dotenv --output-type dotenv "$ENC_FILE" | grep -c '=' ) secrets from .env.enc"

# Run the provided command
exec "$@"
