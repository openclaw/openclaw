#!/bin/bash
# Apply time-based decay to memory importance scores
# Formula: new_importance = importance * (0.99 ^ days_since_accessed)
# Based on Stanford Generative Agents paper (Park et al., 2023)
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
SKILL_DIR="${SKILL_DIR:-$WORKSPACE/skills/hippocampus}"
INDEX="$WORKSPACE/memory/index.json"
BACKUP="$WORKSPACE/memory/index.backup.json"
DECAY_RATE=0.99
ARCHIVE_THRESHOLD=0.2
TODAY=$(date +%Y-%m-%d)

if [ ! -f "$INDEX" ]; then
    echo "❌ index.json not found at $INDEX"
    exit 1
fi

# Backup before modifying
cp "$INDEX" "$BACKUP"

echo "🧠 Memory Decay Process"
echo "======================="
echo "Date: $TODAY"
echo "Decay rate: $DECAY_RATE per day"
echo ""

# Check if decay was already run today
LAST_DECAY=$(python3 -c "import json; print(json.load(open('$INDEX')).get('decayLastRun', 'never'))" 2>/dev/null || echo "never")
if [ "$LAST_DECAY" = "$TODAY" ]; then
    echo "⏸️  Decay already ran today ($LAST_DECAY). Skipping."
    exit 0
fi

# Process each memory
echo "Processing memories..."

python3 << PYTHON
import json
import sys
from datetime import datetime, date

INDEX_PATH = "$INDEX"
DECAY_RATE = 0.99
ARCHIVE_THRESHOLD = 0.2
TODAY = date.today()

with open(INDEX_PATH, 'r') as f:
    data = json.load(f)

decayed = 0
archived_candidates = []

for mem in data.get('memories', []):
    # Parse lastAccessed date
    last_str = mem.get('lastAccessed', mem.get('created', str(TODAY)))
    try:
        # Handle both date and datetime formats
        if 'T' in last_str:
            last_date = datetime.fromisoformat(last_str.replace('Z', '+00:00')).date()
        else:
            last_date = datetime.strptime(last_str, '%Y-%m-%d').date()
    except:
        last_date = TODAY
    
    # Calculate days since last access
    days = (TODAY - last_date).days
    
    if days > 0:
        old_importance = mem['importance']
        # Apply exponential decay
        new_importance = old_importance * (DECAY_RATE ** days)
        # Round to 3 decimal places
        mem['importance'] = round(new_importance, 3)
        
        if new_importance < old_importance:
            decayed += 1
            print(f"  📉 {mem['id']}: {old_importance:.3f} → {new_importance:.3f} ({days}d)")
        
        # Mark for archival review if below threshold
        if new_importance < ARCHIVE_THRESHOLD:
            archived_candidates.append(mem['id'])

# Update metadata
data['decayLastRun'] = str(TODAY)
data['lastUpdated'] = datetime.now().isoformat()

# Write back
with open(INDEX_PATH, 'w') as f:
    json.dump(data, f, indent=2)

print(f"\n✅ Decayed {decayed} memories")
if archived_candidates:
    print(f"⚠️  {len(archived_candidates)} memories below {ARCHIVE_THRESHOLD} threshold:")
    for mid in archived_candidates:
        print(f"   - {mid}")
    print("   Consider reviewing these for archival.")
PYTHON

echo ""
echo "Done. Backup saved to: $BACKUP"

# Sync core memories to markdown for OpenClaw indexing
SYNC_SCRIPT="$SKILL_DIR/scripts/sync-core.sh"
if [ -x "$SYNC_SCRIPT" ]; then
    echo ""
    WORKSPACE="$WORKSPACE" "$SYNC_SCRIPT"
fi
