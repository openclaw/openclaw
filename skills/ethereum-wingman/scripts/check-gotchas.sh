#!/bin/bash
set -e

# Ethereum Wingman: Check Solidity files for common gotchas
# Usage: bash check-gotchas.sh [path]

SEARCH_PATH="${1:-.}"

echo "🔍 Ethereum Wingman: Scanning for common gotchas..." >&2
echo "   Path: $SEARCH_PATH" >&2
echo "" >&2

ISSUES_FOUND=0

# Check for potential infinite approvals
echo "Checking for infinite approvals (type(uint256).max)..." >&2
INFINITE_APPROVALS=$(grep -rn "type(uint256).max" "$SEARCH_PATH" --include="*.sol" 2>/dev/null || true)
if [ -n "$INFINITE_APPROVALS" ]; then
    echo "⚠️  POTENTIAL ISSUE: Infinite approvals found:" >&2
    echo "$INFINITE_APPROVALS" >&2
    echo "" >&2
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

# Check for tx.origin usage
echo "Checking for tx.origin usage..." >&2
TX_ORIGIN=$(grep -rn "tx.origin" "$SEARCH_PATH" --include="*.sol" 2>/dev/null || true)
if [ -n "$TX_ORIGIN" ]; then
    echo "⚠️  POTENTIAL ISSUE: tx.origin found (phishing vulnerability):" >&2
    echo "$TX_ORIGIN" >&2
    echo "" >&2
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

# Check for hardcoded decimals (1e18 patterns without context)
echo "Checking for hardcoded decimals assumptions..." >&2
HARDCODED_DECIMALS=$(grep -rn "1e18\|10\*\*18" "$SEARCH_PATH" --include="*.sol" 2>/dev/null | head -20 || true)
if [ -n "$HARDCODED_DECIMALS" ]; then
    echo "ℹ️  NOTE: Hardcoded 1e18 found - verify these aren't decimal assumptions:" >&2
    echo "$HARDCODED_DECIMALS" >&2
    echo "" >&2
fi

# Check for state changes after external calls
echo "Checking for external calls..." >&2
EXTERNAL_CALLS=$(grep -rn "\.call{" "$SEARCH_PATH" --include="*.sol" 2>/dev/null || true)
if [ -n "$EXTERNAL_CALLS" ]; then
    echo "ℹ️  NOTE: External calls found - verify CEI pattern:" >&2
    echo "$EXTERNAL_CALLS" >&2
    echo "" >&2
fi

# Check for missing ReentrancyGuard
echo "Checking for ReentrancyGuard usage..." >&2
HAS_EXTERNAL_CALLS=$(grep -l "\.call{" "$SEARCH_PATH" --include="*.sol" -r 2>/dev/null || true)
if [ -n "$HAS_EXTERNAL_CALLS" ]; then
    for file in $HAS_EXTERNAL_CALLS; do
        if ! grep -q "nonReentrant\|ReentrancyGuard" "$file" 2>/dev/null; then
            echo "⚠️  POTENTIAL ISSUE: $file has external calls but no ReentrancyGuard" >&2
            ISSUES_FOUND=$((ISSUES_FOUND + 1))
        fi
    done
fi

# Check for getReserves (DEX spot price usage)
echo "Checking for DEX spot price usage..." >&2
DEX_PRICES=$(grep -rn "getReserves\|getSpotPrice" "$SEARCH_PATH" --include="*.sol" 2>/dev/null || true)
if [ -n "$DEX_PRICES" ]; then
    echo "⚠️  POTENTIAL ISSUE: DEX spot price usage found (flash loan vulnerable):" >&2
    echo "$DEX_PRICES" >&2
    echo "" >&2
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
fi

echo "─────────────────────────────────────────" >&2
if [ $ISSUES_FOUND -eq 0 ]; then
    echo "✅ No obvious gotchas found!" >&2
else
    echo "⚠️  Found $ISSUES_FOUND potential issues to review" >&2
fi
echo "" >&2

# Output JSON for machine parsing
echo "{\"issues_found\": $ISSUES_FOUND, \"path\": \"$SEARCH_PATH\"}"
