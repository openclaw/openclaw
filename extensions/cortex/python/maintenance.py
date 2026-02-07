#!/usr/bin/env python3
"""
Cortex Memory Maintenance

Runs nightly/weekly to organize, consolidate, and optimize memory storage.
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Import managers
from stm_manager import load_stm, cleanup_expired
from collections_manager import list_collections, load_collection, save_collection
from embeddings_manager import stats, sync_from_stm, sync_from_collections, search_memories

def nightly_maintenance():
    """
    Nightly maintenance (light):
    - Cleanup expired STM items (7+ days old) → daily logs + collections
    - Sync STM to embeddings
    - Sync collections to embeddings
    """
    print("=== NIGHTLY CORTEX MAINTENANCE ===")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    # Cleanup STM
    print("1. Cleaning up expired STM items...")
    expired = cleanup_expired()
    print(f"   ✅ Expired {expired} items from STM to daily logs + collections\n")
    
    # Sync to embeddings
    print("2. Syncing to embeddings database...")
    stm_count = sync_from_stm()
    col_count = sync_from_collections()
    print(f"   ✅ Synced {stm_count} from STM, {col_count} from collections\n")
    
    # Stats
    s = stats()
    print(f"3. Database stats:")
    print(f"   • Total memories: {s['total']}")
    print(f"   • By category: {dict(list(s['by_category'].items())[:8])}")
    
    print("\n✅ Nightly maintenance complete")

def weekly_maintenance():
    """
    Weekly maintenance (deep):
    - Review high-access memories (promote to MEMORY.md)
    - Trim oversized collections (keep top 100 per category)
    - Detect patterns and connections
    - Remove duplicates
    """
    print("=== WEEKLY CORTEX MAINTENANCE ===")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    # First do nightly tasks
    nightly_maintenance()
    
    print("\n=== DEEP REVIEW ===\n")
    
    # High-access memories
    print("1. Reviewing high-access memories...")
    results = search_memories("", limit=100, temporal_weight=0.3)  # Favor importance
    high_access = [r for r in results if r['access_count'] > 3 and r['importance'] >= 2.5]
    
    print(f"   Found {len(high_access)} frequently-accessed important memories")
    if high_access:
        print("   Top 5:")
        for r in high_access[:5]:
            print(f"   • [{r['access_count']} accesses] {r['content'][:60]}...")
        print(f"\n   💡 Suggestion: Promote these to MEMORY.md for long-term curation")
    
    # Collection sizes
    print("\n2. Checking collection sizes...")
    collections = list_collections()
    oversized = [c for c in collections if c['count'] > 100]
    
    if oversized:
        print(f"   Found {len(oversized)} oversized collections:")
        for c in oversized:
            print(f"   • {c['name']}: {c['count']} items (will trim to 100)")
            
            # Trim collection
            collection = load_collection(c['name'])
            memories = collection.get('memories', [])
            
            # Keep highest importance + most recent
            memories = sorted(memories, key=lambda x: x['importance'], reverse=True)[:100]
            collection['memories'] = memories
            save_collection(c['name'], collection)
            print(f"     ✅ Trimmed to 100")
    else:
        print("   ✅ All collections under 100 items")
    
    # Pattern detection (simple version)
    print("\n3. Detecting patterns...")
    
    # Category growth over time
    s = stats()
    total = s['total']
    by_cat = s['by_category']
    
    print("   Category distribution:")
    for cat, count in sorted(by_cat.items(), key=lambda x: x[1], reverse=True)[:5]:
        pct = (count / total) * 100
        print(f"   • {cat}: {count} ({pct:.1f}%)")
    
    # Temporal distribution
    now = datetime.now()
    week_ago = now - timedelta(days=7)
    recent = search_memories("", date_range=(week_ago.isoformat(), now.isoformat()), limit=1000)
    print(f"\n   Memories from last 7 days: {len(recent)}")
    print(f"   Average per day: {len(recent) / 7:.1f}")
    
    print("\n✅ Weekly maintenance complete")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "nightly"
    
    if mode == "weekly":
        weekly_maintenance()
    elif mode == "nightly":
        nightly_maintenance()
    else:
        print("Usage: python maintenance.py [nightly|weekly]")
        sys.exit(1)
