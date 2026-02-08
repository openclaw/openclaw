#!/bin/bash
# Reinforce a memory (update lastAccessed, bump importance)
# Usage: reinforce.sh <memory_id> [--boost]
#
# --boost: Also increase importance by 15% of remaining headroom
#          new_score = old_score + (1 - old_score) * 0.15
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
INDEX="$WORKSPACE/memory/index.json"
TODAY=$(date +%Y-%m-%d)

MEM_ID="$1"
BOOST=false

if [ "$2" = "--boost" ]; then
    BOOST=true
fi

if [ -z "$MEM_ID" ]; then
    echo "Usage: reinforce.sh <memory_id> [--boost]"
    echo ""
    echo "Examples:"
    echo "  reinforce.sh mem_001          # Just update lastAccessed"
    echo "  reinforce.sh mem_001 --boost  # Also increase importance"
    exit 1
fi

if [ ! -f "$INDEX" ]; then
    echo "❌ index.json not found at $INDEX"
    exit 1
fi

BOOST_VAL="False"
if [ "$BOOST" = "true" ]; then
    BOOST_VAL="True"
fi

python3 << PYTHON
import json
import os
from datetime import datetime

INDEX_PATH = "$INDEX"
MEM_ID = "$MEM_ID"
BOOST = $BOOST_VAL
TODAY = "$TODAY"
REINFORCE_RATE = 0.15

with open(INDEX_PATH, 'r') as f:
    data = json.load(f)

found = False
for mem in data.get('memories', []):
    if mem['id'] == MEM_ID:
        found = True
        old_importance = mem['importance']
        old_reinforced = mem.get('timesReinforced', 0)
        
        # Update lastAccessed
        mem['lastAccessed'] = TODAY
        mem['timesReinforced'] = old_reinforced + 1
        
        if BOOST:
            # Boost: add 15% of remaining headroom
            new_importance = old_importance + (1 - old_importance) * REINFORCE_RATE
            mem['importance'] = round(new_importance, 3)
            print(f"✅ Reinforced {MEM_ID}:")
            print(f"   Importance: {old_importance:.3f} → {new_importance:.3f}")
            print(f"   Times reinforced: {old_reinforced} → {old_reinforced + 1}")
        else:
            print(f"✅ Updated {MEM_ID}:")
            print(f"   lastAccessed: {TODAY}")
            print(f"   Times reinforced: {old_reinforced} → {old_reinforced + 1}")
        
        print(f"   Content: {mem['content'][:60]}...")
        break

if not found:
    print(f"❌ Memory {MEM_ID} not found")
    exit(1)

# Update metadata
data['lastUpdated'] = datetime.now().isoformat()

with open(INDEX_PATH, 'w') as f:
    json.dump(data, f, indent=2)
PYTHON
