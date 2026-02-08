#!/bin/bash
# Sync core memories to HIPPOCAMPUS_CORE.md for auto-injection into context
# This file gets loaded by OpenClaw as workspace context
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)
#   THRESHOLD - Minimum importance score (default: 0.75)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
INDEX="$WORKSPACE/memory/index.json"
OUTPUT="$WORKSPACE/HIPPOCAMPUS_CORE.md"
THRESHOLD="${THRESHOLD:-0.75}"

if [ ! -f "$INDEX" ]; then
    echo "No hippocampus index found at $INDEX"
    exit 0
fi

python3 << PYTHON
import json
import os
from datetime import datetime

INDEX_PATH = "$INDEX"
OUTPUT_PATH = "$OUTPUT"
THRESHOLD = $THRESHOLD

with open(INDEX_PATH, 'r') as f:
    data = json.load(f)

memories = data.get('memories', [])
core = [m for m in memories if m['importance'] >= THRESHOLD]
core.sort(key=lambda x: x['importance'], reverse=True)

# Group by domain
by_domain = {}
for m in core:
    domain = m.get('domain', 'other')
    if domain not in by_domain:
        by_domain[domain] = []
    by_domain[domain].append(m)

# Generate markdown
lines = [
    "# Hippocampus Core Memories",
    "",
    f"*Auto-generated from index.json | {len(core)} memories | threshold ≥ {THRESHOLD}*",
    f"*Last sync: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
    "",
    "These are my highest-importance memories. They decay if unused, strengthen if accessed.",
    "",
]

domain_order = ['user', 'relationship', 'self', 'world']
domain_titles = {
    'user': '## About the user',
    'relationship': '## Our Relationship', 
    'self': '## About Me',
    'world': '## World Knowledge'
}

for domain in domain_order:
    if domain in by_domain:
        lines.append(domain_titles.get(domain, f'## {domain.title()}'))
        lines.append("")
        for m in by_domain[domain]:
            lines.append(f"- **[{m['importance']:.2f}]** {m['content']}")
        lines.append("")

# Write output
with open(OUTPUT_PATH, 'w') as f:
    f.write('\n'.join(lines))

print(f"✅ Synced {len(core)} core memories to {OUTPUT_PATH}")
PYTHON
