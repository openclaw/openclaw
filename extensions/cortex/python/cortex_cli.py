#!/usr/bin/env python3
"""
Cortex CLI - Quick memory operations for Helios
Usage:
  python cortex_cli.py remember "content" [importance]
  python cortex_cli.py recall "query" [limit]
  python cortex_cli.py recent [limit]
  python cortex_cli.py stats
  python cortex_cli.py sync  # Sync to local GPU embeddings
"""
import sys
from collections_manager import add_memory, categorize_memory, list_collections
from stm_manager import add_to_stm, get_recent

# Use HTTP daemon for embeddings (no numpy dependency)
import requests
DAEMON_URL = "http://localhost:8030"

def daemon_available():
    try:
        r = requests.get(f"{DAEMON_URL}/health", timeout=1)
        return r.status_code == 200
    except:
        return False

def daemon_search(query, limit=5):
    try:
        r = requests.post(f"{DAEMON_URL}/search", json={"query": query, "limit": limit}, timeout=5)
        return r.json().get("results", [])
    except:
        return []

def daemon_store(content, category=None, importance=1.0):
    try:
        requests.post(f"{DAEMON_URL}/store", json={
            "content": content, "category": category, "importance": importance
        }, timeout=5)
    except:
        pass

def daemon_stats():
    try:
        r = requests.get(f"{DAEMON_URL}/stats", timeout=5)
        return r.json()
    except:
        return {}

USE_DAEMON = daemon_available()

def remember(content, importance=2.0):
    """Store a memory"""
    categories = categorize_memory(content)
    cat = categories[0] if categories else "general"
    add_to_stm(content, category=cat, importance=importance)
    add_memory(content, importance=importance)
    # Also store in daemon/local embeddings for semantic search
    daemon_store(content, category=cat, importance=importance)
    print(f"✅ Stored: '{content[:50]}...' → {categories} (importance: {importance})")

def recall(query, limit=5):
    """Search memories using daemon (instant) or direct GPU"""
    results = daemon_search(query, limit=limit)
    
    mode = "⚡ DAEMON" if USE_DAEMON else "🔥 GPU"
    print(f"🔍 {mode} search for '{query}':")
    print(f"   Found {len(results)} results:")
    for r in results:
        content = r.get('content', '')[:65]
        score = r.get('score', 0)
        imp = r.get('importance', 1.0)
        print(f"  [{score:.2f}|{imp:.0f}] {content}...")

def recent(limit=5):
    """Get recent STM items"""
    items = get_recent(limit=limit)
    print(f"🧠 Recent {len(items)} STM items:")
    for item in items:
        print(f"  [{item.get('importance', 1.0):.1f}] {item.get('content', '')[:60]}...")

def show_stats():
    """Show memory stats"""
    collections = list_collections()
    total = sum(c['count'] for c in collections)
    s = stats()
    print(f"📊 Cortex Stats:")
    print(f"   Collections: {len(collections)}")
    print(f"   Total memories: {total}")
    print(f"   Embeddings indexed: {s.get('total_memories', '?')}")
    print(f"   STM items: {len(get_recent(limit=100))}")

def sync():
    """Sync collections to daemon embeddings (run in miniconda env)"""
    print("⚠️ Sync requires miniconda environment. Run:")
    print("   source ~/miniconda3/bin/activate && python local_embeddings.py sync")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    if cmd == "remember" and len(sys.argv) >= 3:
        imp = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
        remember(sys.argv[2], imp)
    elif cmd == "recall" and len(sys.argv) >= 3:
        lim = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        recall(sys.argv[2], lim)
    elif cmd == "recent":
        lim = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        recent(lim)
    elif cmd == "stats":
        show_stats()
    elif cmd == "sync":
        sync()
    else:
        print(__doc__)
