#!/bin/bash
# Graphify Auto-Update Hook
# Runs after git merge to update knowledge graph incrementally

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "[graphify] Checking if graph needs update..."

# Check if graphify is installed
if ! command -v graphify &> /dev/null; then
    echo "[graphify] graphify not installed. Run: pip install graphifyy"
    exit 0
fi

# Check if graph already exists
if [ ! -f "graphify-out/graph.json" ]; then
    echo "[graphify] No existing graph found. Run: graphify . to build initial graph"
    exit 0
fi

# Check if we're in a git repository with changes
if git rev-parse --git-dir > /dev/null 2>&1; then
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        echo "[graphify] Uncommitted changes detected. Commit or stash before updating graph."
        exit 0
    fi
fi

# Run incremental update
echo "[graphify] Running incremental graph update..."
graphify . --update --no-viz

echo "[graphify] Graph updated successfully"
echo "   Report: graphify-out/GRAPH_REPORT.md"
