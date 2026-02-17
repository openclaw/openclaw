#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$BASE_DIR/discord-context-cli.cjs" "$@"
