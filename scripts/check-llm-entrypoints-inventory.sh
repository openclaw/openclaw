#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SNAPSHOT="docs/router-llm-entrypoints-inventory.snapshot.txt"
TMP=$(mktemp)

# Generate current inventory (non-test)
{
  echo "## runWithModelFallback calls"
  rg -n "runWithModelFallback\\(" src | rg -v "\.test\.ts" | sort -u || true
  echo
  echo "## runWithImageModelFallback calls"
  rg -n "runWithImageModelFallback\\(" src | rg -v "\.test\.ts" | sort -u || true
  echo
  echo "## runEmbeddedPiAgent calls (non-test only)"
  rg -n "runEmbeddedPiAgent\\(" src | rg -v "\.test\.ts" | rg -v "\.run-embedded-pi-agent\.auth-profile-rotation\.test\.ts" | sort -u || true
  echo
  echo "## createAgentSession calls"
  rg -n "createAgentSession\\(" src | rg -v "\.test\.ts" | sort -u || true
  echo
  echo "## session.compact calls"
  rg -n "session\\.compact\\(" src | rg -v "\.test\.ts" | sort -u || true
} > "$TMP"

if [[ ! -f "$SNAPSHOT" ]]; then
  echo "ERROR: snapshot file missing at $SNAPSHOT"
  exit 1
fi

# Compare
if ! diff -u "$SNAPSHOT" "$TMP"; then
  echo
  echo "ERROR: LLM entrypoints inventory changed. Update snapshot after review." 
  echo "To update snapshot intentionally: run scripts/generate-llm-entrypoints-inventory.sh and copy results into $SNAPSHOT" 
  exit 1
fi

echo "OK: entrypoints inventory matches snapshot."