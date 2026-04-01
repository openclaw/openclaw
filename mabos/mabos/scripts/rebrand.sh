#!/usr/bin/env bash
#
# rebrand.sh — Re-apply MABOS branding after an upstream merge.
#
# This script makes the ~5 deterministic edits to upstream source files
# that constitute the entire conflict surface.  Run it after every
# `git merge upstream/main` to restore MABOS branding.
#
# Usage:
#   bash mabos/scripts/rebrand.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[rebrand] Applying MABOS branding to upstream files..."

# ── 1. package.json ─────────────────────────────────────────────
# Replace name field (idempotent via sed)
if grep -q '"name": "openclaw"' package.json; then
  sed -i 's/"name": "openclaw"/"name": "mabos"/' package.json
  echo "[rebrand] package.json: name → mabos"
fi
# Ensure mabos bin entry exists
if ! grep -q '"mabos":' package.json; then
  sed -i '/"openclaw": "openclaw.mjs"/i\    "mabos": "mabos.mjs",' package.json
  echo "[rebrand] package.json: added mabos bin entry"
fi
# Ensure mabos.mjs in files array
if ! grep -q '"mabos.mjs"' package.json; then
  sed -i '/"openclaw.mjs",/a\    "mabos.mjs",' package.json
  echo "[rebrand] package.json: added mabos.mjs to files"
fi

# ── 2. src/infra/openclaw-root.ts ──────────────────────────────
ROOT_TS="src/infra/openclaw-root.ts"
if grep -q 'new Set(\["openclaw"\])' "$ROOT_TS"; then
  sed -i 's/new Set(\["openclaw"\])/new Set(["openclaw", "mabos"])/' "$ROOT_TS"
  echo "[rebrand] openclaw-root.ts: added 'mabos' to CORE_PACKAGE_NAMES"
fi

# ── 3. src/config/paths.ts ─────────────────────────────────────
PATHS_TS="src/config/paths.ts"
if ! grep -q 'MABOS_STATE_DIRNAME' "$PATHS_TS"; then
  echo "[rebrand] WARNING: paths.ts does not contain MABOS patches."
  echo "         You may need to manually re-apply the MABOS state-dir changes."
  echo "         See mabos/scripts/rebrand.sh for expected diffs."
fi

# ── 4. tsdown.config.ts (no changes needed unless mabos/ has build entries) ──
echo "[rebrand] tsdown.config.ts: no changes needed (MABOS code builds via extensions)"

# ── 5. vitest.unit.config.ts (no changes needed unless mabos/ has unit tests) ──
echo "[rebrand] vitest.unit.config.ts: no changes needed"

echo "[rebrand] Done. Run 'pnpm build && pnpm test:fast' to verify."
