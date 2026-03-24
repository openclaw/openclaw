#!/bin/bash
# Script to help migrate OPENCLAW_* env vars to EVOX_* with backward compat
# This shows files that need manual review

set -e

SRC_DIR="$HOME/.EVOX.sh/src"

echo "=== Files using OPENCLAW_* env vars ==="
echo ""

# Group by pattern
echo "### Direct env access (env.OPENCLAW_*) - needs getEnv() helper ###"
grep -rln "env\.OPENCLAW_" "$SRC_DIR" 2>/dev/null | grep -v test | grep -v ".map" | sort -u | head -30

echo ""
echo "### Process.env access (process.env.OPENCLAW_*) ###"
grep -rln "process\.env\.OPENCLAW_" "$SRC_DIR" 2>/dev/null | grep -v test | grep -v ".map" | sort -u | head -30

echo ""
echo "### String literals (\"OPENCLAW_* or 'OPENCLAW_*) ###"
grep -rln '"OPENCLAW_\|'"'"'OPENCLAW_' "$SRC_DIR" 2>/dev/null | grep -v test | grep -v ".map" | sort -u | head -30

echo ""
echo "=== Total unique files ==="
grep -rln "OPENCLAW_" "$SRC_DIR" 2>/dev/null | grep -v test | grep -v ".map" | sort -u | wc -l
