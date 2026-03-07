#!/usr/bin/env bash
# Sync memory, bank, and task files across cluster nodes.
#
# Usage: openclaw/scripts/sync-memory.sh
#
# Runs from i7 (sentinel) every 30 minutes.
# Syncs the source-of-truth (M4) to all other nodes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SOURCE_NODE="claw-m4"
TARGET_NODES=("claw-m1" "claw-i7")
SYNC_DIRS=("openclaw/memory" "openclaw/bank" "openclaw/tasks")
REMOTE_APP_DIR="~/openclaw"

echo "=== Memory Sync ==="
echo "Source: $SOURCE_NODE"
echo "Targets: ${TARGET_NODES[*]}"
echo ""

for target in "${TARGET_NODES[@]}"; do
    echo "Syncing to $target..."

    # Check connectivity
    if ! ssh -o ConnectTimeout=5 "$target" "echo ok" >/dev/null 2>&1; then
        echo "  WARNING: $target unreachable — skipping"
        continue
    fi

    for dir in "${SYNC_DIRS[@]}"; do
        rsync -az --delete \
            -e "ssh -o ConnectTimeout=5" \
            "$SOURCE_NODE:$REMOTE_APP_DIR/$dir/" \
            "$target:$REMOTE_APP_DIR/$dir/" \
            2>/dev/null \
            && echo "  $dir: synced" \
            || echo "  $dir: FAILED"
    done

    echo ""
done

echo "=== Sync Complete ==="
