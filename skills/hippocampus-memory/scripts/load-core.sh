#!/bin/bash
# Load core memories (importance >= 0.7) for session start
# Outputs formatted memory list for context injection
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)
#   THRESHOLD - Minimum importance score (default: 0.7)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
INDEX="$WORKSPACE/memory/index.json"
THRESHOLD="${THRESHOLD:-0.7}"

if [ ! -f "$INDEX" ]; then
    echo "No hippocampus index found at $INDEX"
    exit 0
fi

python3 << PYTHON
import json
import os

INDEX_PATH = "$INDEX"
THRESHOLD = $THRESHOLD

with open(INDEX_PATH, 'r') as f:
    data = json.load(f)

memories = data.get('memories', [])
core = [m for m in memories if m['importance'] >= THRESHOLD]
core.sort(key=lambda x: x['importance'], reverse=True)

if not core:
    print("No core memories above threshold")
else:
    print(f"🧠 HIPPOCAMPUS: {len(core)} core memories (importance ≥ {THRESHOLD})")
    print("")
    
    # Group by domain
    by_domain = {}
    for m in core:
        domain = m.get('domain', 'other')
        if domain not in by_domain:
            by_domain[domain] = []
        by_domain[domain].append(m)
    
    for domain in ['user', 'self', 'relationship', 'world']:
        if domain in by_domain:
            print(f"**{domain.upper()}**")
            for m in by_domain[domain]:
                print(f"  • [{m['importance']:.2f}] {m['content']}")
            print("")
PYTHON
