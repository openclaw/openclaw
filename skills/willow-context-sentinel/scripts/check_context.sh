#!/usr/bin/env bash
# check_context.sh — Willow Context Sentinel
# Part of the willow-context-sentinel OpenClaw skill.
#
# Reads ~/.willow/anchor_state.json and ~/.willow/session_anchor.json,
# then outputs one of:
#   STATUS_OK      — prompt_count < 15, postgres up
#   COMPACT_NOW    — prompt_count 15–25
#   HANDOFF_NOW    — prompt_count > 25
#   POSTGRES_DOWN  — postgres reported as down in session_anchor.json
#
# Exits 0 in all cases. Missing state files are treated as STATUS_OK
# (fail open) with a warning on stderr.

set -euo pipefail

ANCHOR_STATE="${HOME}/.willow/anchor_state.json"
SESSION_ANCHOR="${HOME}/.willow/session_anchor.json"

# ---------------------------------------------------------------------------
# Postgres check — takes priority over all context checks
# ---------------------------------------------------------------------------
if [[ -f "$SESSION_ANCHOR" ]]; then
    # Extract the postgres field; accept "down", "DOWN", or "false"
    pg_status=$(python3 -c "
import json, sys
try:
    data = json.load(open('$SESSION_ANCHOR'))
    val = str(data.get('postgres', '')).lower()
    print(val)
except Exception as e:
    print('unknown', file=sys.stderr)
    print('')
" 2>/dev/null || true)

    if [[ "$pg_status" == "down" || "$pg_status" == "false" ]]; then
        echo "POSTGRES_DOWN"
        exit 0
    fi
else
    echo "WARNING: $SESSION_ANCHOR not found — skipping postgres check" >&2
fi

# ---------------------------------------------------------------------------
# Context check via prompt_count
# ---------------------------------------------------------------------------
if [[ ! -f "$ANCHOR_STATE" ]]; then
    echo "WARNING: $ANCHOR_STATE not found — cannot read prompt_count, defaulting to STATUS_OK" >&2
    echo "STATUS_OK"
    exit 0
fi

prompt_count=$(python3 -c "
import json, sys
try:
    data = json.load(open('$ANCHOR_STATE'))
    val = data.get('prompt_count', 0)
    print(int(val))
except Exception as e:
    print('ERROR reading prompt_count: ' + str(e), file=sys.stderr)
    sys.exit(1)
" 2>/dev/null) || {
    echo "WARNING: failed to parse $ANCHOR_STATE — defaulting to STATUS_OK" >&2
    echo "STATUS_OK"
    exit 0
}

# ---------------------------------------------------------------------------
# Threshold routing
# ---------------------------------------------------------------------------
if (( prompt_count > 25 )); then
    echo "HANDOFF_NOW"
elif (( prompt_count >= 15 )); then
    echo "COMPACT_NOW"
else
    echo "STATUS_OK"
fi
