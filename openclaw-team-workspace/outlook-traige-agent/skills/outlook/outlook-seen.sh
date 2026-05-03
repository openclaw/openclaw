#!/bin/bash
# Outlook Seen Store — tracks processed email IDs to avoid re-triaging
# Usage: outlook-seen.sh <command> [args]
#
# Commands:
#   check <id>       - Exit 0 if seen, exit 1 if new
#   add <id> [id...] - Mark IDs as seen
#   seed             - Seed store with all current unread IDs (first-run warmup)
#   list             - List all seen IDs
#   count            - Count of seen IDs
#   reset            - Clear the store
#   prune [limit]    - Keep only the most recent N IDs (default: 500)

set -e

SEEN_FILE="${OUTLOOK_SEEN_FILE:-$HOME/.outlook-mcp/seen_ids.json}"
OUTLOOK_MAIL="${OUTLOOK_MAIL_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/outlook-mail.sh}"
DEFAULT_PRUNE_LIMIT=500

# Ensure seen file exists
_init() {
    mkdir -p "$(dirname "$SEEN_FILE")"
    if [ ! -f "$SEEN_FILE" ]; then
        echo '{"seen_ids":[],"last_seeded":null}' > "$SEEN_FILE"
    fi
}

# Check if an ID is already seen
_check() {
    local ID="$1"
    if [ -z "$ID" ]; then
        echo "Usage: outlook-seen.sh check <id>"
        exit 2
    fi
    _init
    local FOUND
    FOUND=$(jq -r --arg id "$ID" '.seen_ids | index($id) // empty' "$SEEN_FILE")
    if [ -n "$FOUND" ]; then
        echo '{"seen": true, "id": "'"$ID"'"}'
        exit 0
    else
        echo '{"seen": false, "id": "'"$ID"'"}'
        exit 1
    fi
}

# Add one or more IDs to the seen store
_add() {
    if [ $# -eq 0 ]; then
        echo "Usage: outlook-seen.sh add <id> [id...]"
        exit 2
    fi
    _init
    local TEMP_FILE
    TEMP_FILE=$(mktemp)
    # Build a JSON array of new IDs
    local NEW_IDS
    NEW_IDS=$(printf '%s\n' "$@" | jq -R . | jq -s .)
    jq --argjson new "$NEW_IDS" '
        .seen_ids = (.seen_ids + $new | unique)
    ' "$SEEN_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SEEN_FILE"
    echo "{\"status\": \"added\", \"count\": $#}"
}

# Seed the store with all current unread email IDs (warmup — no classification)
_seed() {
    _init
    # Check if already seeded
    local ALREADY_SEEDED
    ALREADY_SEEDED=$(jq -r '.last_seeded // empty' "$SEEN_FILE")
    if [ -n "$ALREADY_SEEDED" ]; then
        echo "{\"status\": \"already_seeded\", \"seeded_at\": \"$ALREADY_SEEDED\"}"
        return 0
    fi

    # Get all current unread IDs
    local RAW_OUTPUT
    RAW_OUTPUT=$("$OUTLOOK_MAIL" unread 50 2>/dev/null) || true

    if [ -z "$RAW_OUTPUT" ]; then
        # No unread emails — just mark as seeded
        local TEMP_FILE
        TEMP_FILE=$(mktemp)
        jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
            .last_seeded = $ts
        ' "$SEEN_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SEEN_FILE"
        echo '{"status": "seeded", "count": 0}'
        return 0
    fi

    # Extract all IDs from the unread output
    local IDS
    IDS=$(echo "$RAW_OUTPUT" | jq -r '.id // empty' 2>/dev/null | grep -v '^$')

    if [ -z "$IDS" ]; then
        local TEMP_FILE
        TEMP_FILE=$(mktemp)
        jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
            .last_seeded = $ts
        ' "$SEEN_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SEEN_FILE"
        echo '{"status": "seeded", "count": 0}'
        return 0
    fi

    local ID_ARRAY
    ID_ARRAY=$(echo "$IDS" | jq -R . | jq -s .)
    local COUNT
    COUNT=$(echo "$ID_ARRAY" | jq 'length')

    local TEMP_FILE
    TEMP_FILE=$(mktemp)
    jq --argjson ids "$ID_ARRAY" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        .seen_ids = (.seen_ids + $ids | unique) |
        .last_seeded = $ts
    ' "$SEEN_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SEEN_FILE"

    echo "{\"status\": \"seeded\", \"count\": $COUNT}"
}

# List all seen IDs
_list() {
    _init
    jq '.seen_ids[]' "$SEEN_FILE"
}

# Count seen IDs
_count() {
    _init
    jq '{count: (.seen_ids | length), last_seeded: .last_seeded}' "$SEEN_FILE"
}

# Reset the store
_reset() {
    echo '{"seen_ids":[],"last_seeded":null}' > "$SEEN_FILE"
    echo '{"status": "reset"}'
}

# Prune to keep only the most recent N IDs
_prune() {
    local LIMIT="${1:-$DEFAULT_PRUNE_LIMIT}"
    _init
    local BEFORE
    BEFORE=$(jq '.seen_ids | length' "$SEEN_FILE")
    local TEMP_FILE
    TEMP_FILE=$(mktemp)
    jq --argjson limit "$LIMIT" '
        .seen_ids = .seen_ids[-$limit:]
    ' "$SEEN_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$SEEN_FILE"
    local AFTER
    AFTER=$(jq '.seen_ids | length' "$SEEN_FILE")
    echo "{\"status\": \"pruned\", \"before\": $BEFORE, \"after\": $AFTER, \"removed\": $((BEFORE - AFTER))}"
}

# Filter unread output to only new (unseen) emails — returns JSON lines
_filter_new() {
    _init
    local RAW_OUTPUT
    RAW_OUTPUT=$("$OUTLOOK_MAIL" unread "${1:-20}" 2>/dev/null) || true

    if [ -z "$RAW_OUTPUT" ]; then
        echo '{"new_emails": 0}'
        return 0
    fi

    # For each email in the output, check if its ID is in seen store
    local SEEN_IDS
    SEEN_IDS=$(jq -r '.seen_ids[]' "$SEEN_FILE" 2>/dev/null)

    echo "$RAW_OUTPUT" | jq -c '.' | while IFS= read -r line; do
        local EMAIL_ID
        EMAIL_ID=$(echo "$line" | jq -r '.id // empty')
        if [ -n "$EMAIL_ID" ] && ! echo "$SEEN_IDS" | grep -qF "$EMAIL_ID"; then
            echo "$line"
        fi
    done
}

case "$1" in
    check)    _check "$2" ;;
    add)      shift; _add "$@" ;;
    seed)     _seed ;;
    list)     _list ;;
    count)    _count ;;
    reset)    _reset ;;
    prune)    _prune "$2" ;;
    filter-new) _filter_new "$2" ;;
    *)
        echo "Usage: outlook-seen.sh <command> [args]"
        echo ""
        echo "Commands:"
        echo "  check <id>        - Check if ID is seen (exit 0=seen, 1=new)"
        echo "  add <id> [id...]  - Mark IDs as seen"
        echo "  seed              - Warmup: seed store with current unread IDs"
        echo "  filter-new [count]- Get only unseen unread emails"
        echo "  list              - List all seen IDs"
        echo "  count             - Count seen IDs + last seeded time"
        echo "  reset             - Clear the store"
        echo "  prune [limit]     - Keep only most recent N IDs (default: 500)"
        ;;
esac