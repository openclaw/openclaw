#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT=${1:-"docs/router-llm-entrypoints-inventory.txt"}
mkdir -p "$(dirname "$OUT")"

{
  echo "# LLM Entrypoints Inventory (auto-generated)"
  echo "# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo
  echo "## runWithModelFallback calls"
  rg -n "runWithModelFallback\\(" src || true
  echo
  echo "## runWithImageModelFallback calls"
  rg -n "runWithImageModelFallback\\(" src || true
  echo
  echo "## runEmbeddedPiAgent calls"
  rg -n "runEmbeddedPiAgent\\(" src || true
  echo
  echo "## createAgentSession calls"
  rg -n "createAgentSession\\(" src || true
  echo
  echo "## session.compact calls"
  rg -n "session\\.compact\\(" src || true
} > "$OUT"

echo "Wrote $OUT"