#!/bin/bash
set -euo pipefail

# Compact all openclaw agent sessions on the DO droplet.
# Usage: ./scripts/compact-all-sessions.sh [--max-lines N] [--dry-run] [--local]
#
# Options:
#   --max-lines N   Max lines to keep after compaction (default: 400)
#   --dry-run       List sessions without compacting
#   --local         Run against local gateway instead of droplet

DROPLET="root@159.223.128.170"
SSH_KEY="$HOME/.ssh/id_ed25519_commandery"
MAX_LINES=400
DRY_RUN=false
LOCAL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-lines) MAX_LINES="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --local)     LOCAL=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--max-lines N] [--dry-run] [--local]"
      echo "  --max-lines N   Lines to keep after compaction (default: 400)"
      echo "  --dry-run       List sessions without compacting"
      echo "  --local         Run against local gateway instead of droplet"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

run_cmd() {
  if $LOCAL; then
    eval "$1"
  else
    ssh -n -i "$SSH_KEY" "$DROPLET" "$1"
  fi
}

echo "Listing sessions..."
SESSIONS_JSON=$(run_cmd "openclaw sessions --json 2>/dev/null")

# Extract session keys that have token data (non-null totalTokens)
KEYS=$(echo "$SESSIONS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
seen = set()
for s in data['sessions']:
    key = s['key']
    tokens = s.get('totalTokens')
    if tokens is not None and key not in seen:
        seen.add(key)
        print(f'{tokens}\t{key}')
" | sort -rn)

TOTAL=$(echo "$KEYS" | grep -c . || true)
echo "Found $TOTAL sessions with token data."
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo "Nothing to compact."
  exit 0
fi

if $DRY_RUN; then
  echo "DRY RUN — would compact these sessions (maxLines=$MAX_LINES):"
  echo ""
  printf "%-8s  %s\n" "TOKENS" "SESSION KEY"
  printf "%-8s  %s\n" "------" "-----------"
  echo "$KEYS" | while IFS=$'\t' read -r tokens key; do
    printf "%-8s  %s\n" "$tokens" "$key"
  done
  exit 0
fi

echo "Compacting $TOTAL sessions (maxLines=$MAX_LINES)..."
echo ""

COMPACTED=0
SKIPPED=0
ERRORS=0

echo "$KEYS" | while IFS=$'\t' read -r tokens key; do
  printf "  %-60s %6s tokens → " "$key" "$tokens"
  RESULT=$(run_cmd "openclaw gateway call sessions.compact --params '{\"key\":\"$key\",\"maxLines\":$MAX_LINES}' --json 2>&1") || true

  if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('compacted') else 1)" 2>/dev/null; then
    KEPT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('kept','?'))")
    echo "compacted (kept $KEPT lines)"
    COMPACTED=$((COMPACTED + 1))
  elif echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" 2>/dev/null; then
    echo "skipped (already compact)"
    SKIPPED=$((SKIPPED + 1))
  else
    echo "ERROR"
    echo "    $RESULT" | head -1
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
echo "Done."
