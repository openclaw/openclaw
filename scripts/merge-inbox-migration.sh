#!/usr/bin/env bash
# One-time migration: merge business-scoped inbox files into canonical agent-scoped locations.
# Usage: bash scripts/merge-inbox-migration.sh /path/to/workspace
set -euo pipefail

WS="${1:-$HOME/.openclaw/workspace}"
BIZ_AGENTS_DIR="$WS/businesses/vividwalls/agents"
CANONICAL_AGENTS_DIR="$WS/agents"

if [ ! -d "$BIZ_AGENTS_DIR" ]; then
  echo "No business-scoped agents dir at $BIZ_AGENTS_DIR — nothing to migrate."
  exit 0
fi

merged=0
skipped=0

for biz_inbox in "$BIZ_AGENTS_DIR"/*/inbox.json; do
  [ -f "$biz_inbox" ] || continue
  agent_id=$(basename "$(dirname "$biz_inbox")")
  canonical_dir="$CANONICAL_AGENTS_DIR/$agent_id"
  canonical_inbox="$canonical_dir/inbox.json"

  # Read business-scoped messages
  biz_count=$(python3 -c "
import json, sys
try:
    msgs = json.load(open('$biz_inbox'))
    print(len(msgs) if isinstance(msgs, list) else 0)
except: print(0)
")

  if [ "$biz_count" = "0" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  # Ensure canonical agent dir exists
  mkdir -p "$canonical_dir"

  # Merge: dedup by message ID
  python3 -c "
import json, sys, os

biz_path = '$biz_inbox'
canon_path = '$canonical_inbox'

# Read business-scoped inbox
try:
    with open(biz_path) as f:
        biz_msgs = json.load(f)
    if not isinstance(biz_msgs, list):
        biz_msgs = []
except:
    biz_msgs = []

# Read canonical inbox (may not exist)
try:
    with open(canon_path) as f:
        canon_msgs = json.load(f)
    if not isinstance(canon_msgs, list):
        canon_msgs = []
except:
    canon_msgs = []

# Dedup by message ID
seen_ids = set()
merged = []
for msg in canon_msgs:
    msg_id = msg.get('id', '')
    if msg_id not in seen_ids:
        seen_ids.add(msg_id)
        merged.append(msg)
for msg in biz_msgs:
    msg_id = msg.get('id', '')
    if msg_id not in seen_ids:
        seen_ids.add(msg_id)
        merged.append(msg)

# Sort by timestamp
merged.sort(key=lambda m: m.get('timestamp', ''))

# Write merged result to canonical location
with open(canon_path, 'w') as f:
    json.dump(merged, f, indent=2)

# Clear the business-scoped inbox
with open(biz_path, 'w') as f:
    json.dump([], f, indent=2)

print(f'  {len(biz_msgs)} biz + {len(canon_msgs)} canonical -> {len(merged)} merged')
"

  echo "[$agent_id] Merged from $biz_inbox -> $canonical_inbox"
  merged=$((merged + 1))
done

echo ""
echo "Migration complete: $merged agents merged, $skipped skipped (empty)."
