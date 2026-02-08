#!/bin/bash
# Search hippocampus memories with importance-weighted scoring
# Combines keyword matching with importance scores
# Usage: recall.sh <query> [--top N] [--min-score 0.5] [--reinforce]
#
# --reinforce: Update lastAccessed for returned memories
#
# Environment:
#   WORKSPACE - OpenClaw workspace directory (default: ~/.openclaw/workspace)

set -e

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
INDEX="$WORKSPACE/memory/index.json"

QUERY="$1"
TOP=5
MIN_SCORE=0.3
REINFORCE=false

# Parse args
shift || true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --top) TOP="$2"; shift 2 ;;
        --min-score) MIN_SCORE="$2"; shift 2 ;;
        --reinforce) REINFORCE=true; shift ;;
        *) shift ;;
    esac
done

if [ -z "$QUERY" ]; then
    echo "Usage: recall.sh <query> [--top N] [--min-score 0.5] [--reinforce]"
    echo ""
    echo "Examples:"
    echo "  recall.sh 'the user preferences'"
    echo "  recall.sh 'visa work' --top 10"
    echo "  recall.sh 'trust' --reinforce"
    exit 1
fi

if [ ! -f "$INDEX" ]; then
    echo "❌ index.json not found at $INDEX"
    exit 1
fi

REINFORCE_VAL="False"
if [ "$REINFORCE" = "true" ]; then
    REINFORCE_VAL="True"
fi

python3 << PYTHON
import json
import os
import re
from datetime import datetime, date

INDEX_PATH = "$INDEX"
QUERY = "$QUERY".lower()
TOP = $TOP
MIN_SCORE = $MIN_SCORE
REINFORCE = $REINFORCE_VAL
TODAY = str(date.today())

# Simple keyword matching (could be replaced with embeddings later)
def keyword_score(mem, query_terms):
    """Calculate keyword match score (0-1)"""
    # Support both 'content' and 'text' fields
    text = mem.get('content', mem.get('text', ''))
    searchable = (
        text.lower() + ' ' +
        ' '.join(mem.get('keywords', [])).lower() + ' ' +
        mem.get('domain', '') + ' ' +
        mem.get('category', '')
    )
    
    matches = sum(1 for term in query_terms if term in searchable)
    return matches / len(query_terms) if query_terms else 0

with open(INDEX_PATH, 'r') as f:
    data = json.load(f)

# Parse query into terms
query_terms = [t.strip() for t in QUERY.split() if len(t.strip()) > 2]

results = []
for mem in data.get('memories', []):
    kw_score = keyword_score(mem, query_terms)
    importance = mem['importance']
    
    # Combined score: 40% keyword match + 60% importance
    # (importance-heavy because we trust the scoring)
    combined = (0.4 * kw_score) + (0.6 * importance)
    
    if kw_score > 0:  # Only include if there's some match
        results.append({
            'id': mem['id'],
            'content': mem.get('content', mem.get('text', '')),
            'importance': importance,
            'kw_score': kw_score,
            'combined': combined,
            'domain': mem.get('domain', ''),
            'category': mem.get('category', ''),
        })

# Sort by combined score
results.sort(key=lambda x: x['combined'], reverse=True)
results = [r for r in results if r['combined'] >= MIN_SCORE][:TOP]

if not results:
    print(f"No memories found for: {QUERY}")
else:
    print(f"🧠 Hippocampus Recall: '{QUERY}'")
    print(f"   (showing top {len(results)}, min_score={MIN_SCORE})")
    print("")
    
    reinforced_ids = []
    for i, r in enumerate(results, 1):
        print(f"{i}. [{r['domain']}/{r['category']}] (score: {r['combined']:.2f}, imp: {r['importance']:.2f})")
        print(f"   {r['content']}")
        print(f"   ID: {r['id']}")
        print("")
        reinforced_ids.append(r['id'])
    
    # Reinforce if requested
    if REINFORCE and reinforced_ids:
        for mem in data.get('memories', []):
            if mem['id'] in reinforced_ids:
                mem['lastAccessed'] = TODAY
                mem['timesReinforced'] = mem.get('timesReinforced', 0) + 1
        
        data['lastUpdated'] = datetime.now().isoformat()
        with open(INDEX_PATH, 'w') as f:
            json.dump(data, f, indent=2)
        
        print(f"📌 Reinforced {len(reinforced_ids)} memories (updated lastAccessed)")
PYTHON
