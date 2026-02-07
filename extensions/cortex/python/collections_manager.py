#!/usr/bin/env python3
"""
Collections Manager - Phase 2 of Cortex Memory System

Auto-categorizes memories into domain-specific collections.
Prevents "misc" pile-up by using LLM to detect domains.

Data directory can be configured via CORTEX_DATA_DIR environment variable.
"""
import json
import os
from pathlib import Path
from datetime import datetime

# Data directory: use CORTEX_DATA_DIR env var or default to script directory
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).parent))
COLLECTIONS_DIR = DATA_DIR / "collections"

# Load categories from config file (extensible!)
def load_categories_config():
    """Load categories from categories.json config file"""
    config_path = DATA_DIR / "categories.json"
    if config_path.exists():
        with open(config_path, 'r') as f:
            config = json.load(f)
            return config.get("categories", {})
    # Fallback defaults if no config
    return {
        "moltbook": {"description": "Social network activity", "keywords": ["moltbook", "post"]},
        "trading": {"description": "Market analysis", "keywords": ["trading", "bot", "profit"]},
        "coding": {"description": "Software development", "keywords": ["code", "bug", "fix"]},
        "meta": {"description": "Reflections on agency", "keywords": ["reflect", "agency"]},
        "learning": {"description": "New knowledge", "keywords": ["learn", "insight"]},
        "system": {"description": "Configuration", "keywords": ["config", "gateway"]},
        "personal": {"description": "Preferences", "keywords": ["prefer", "like"]},
    }

# Load at module init - can be refreshed by calling load_categories_config()
CATEGORIES_CONFIG = load_categories_config()
CATEGORIES = {k: v.get("description", k) for k, v in CATEGORIES_CONFIG.items()}

def load_collection(category):
    """Load a collection file"""
    path = COLLECTIONS_DIR / f"{category}.json"
    if path.exists():
        with open(path, 'r') as f:
            return json.load(f)
    return {
        "category": category,
        "description": CATEGORIES.get(category, "General"),
        "memories": [],
        "created_at": datetime.now().isoformat()
    }

def save_collection(category, data):
    """Save a collection file"""
    COLLECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = COLLECTIONS_DIR / f"{category}.json"
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)

def categorize_memory(content):
    """
    Categorize a memory using keyword matching from config.
    Returns list of categories (can be multiple).
    Categories are loaded from categories.json - fully extensible!
    """
    content_lower = content.lower()
    categories = []
    
    # Load fresh config (allows runtime updates)
    config = load_categories_config()
    
    # Check each category's keywords
    for category, settings in config.items():
        keywords = settings.get("keywords", [])
        if any(k.lower() in content_lower for k in keywords):
            categories.append(category)
    
    # Default to personal if no match
    if not categories:
        categories.append('personal')
    
    return categories

def add_memory(content, importance=1.0, force_category=None):
    """Add a memory to appropriate collection(s)"""
    memory = {
        "content": content,
        "timestamp": datetime.now().isoformat(),
        "importance": importance,
        "access_count": 0
    }
    
    if force_category:
        categories = [force_category]
    else:
        categories = categorize_memory(content)
    
    # Add to each matching collection
    for category in categories:
        collection = load_collection(category)
        collection["memories"].append(memory)
        
        # Keep collections reasonably sized (max 100 items)
        if len(collection["memories"]) > 100:
            # Keep high-importance items
            collection["memories"] = sorted(
                collection["memories"],
                key=lambda x: x["importance"],
                reverse=True
            )[:100]
        
        save_collection(category, collection)
    
    return categories

def search_collection(category, query=None, limit=10):
    """Search within a specific collection"""
    collection = load_collection(category)
    memories = collection["memories"]
    
    if query:
        query_lower = query.lower()
        memories = [m for m in memories if query_lower in m["content"].lower()]
    
    # Sort by importance * recency
    now = datetime.now()
    for memory in memories:
        ts = datetime.fromisoformat(memory["timestamp"])
        # Handle timezone-aware vs naive datetimes
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        days_ago = (now - ts).days + 1
        memory["score"] = memory["importance"] / days_ago
    
    memories = sorted(memories, key=lambda x: x.get("score", 0), reverse=True)
    
    return memories[:limit]

def list_collections():
    """List all available collections"""
    COLLECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    collections = []
    
    for path in COLLECTIONS_DIR.glob("*.json"):
        with open(path, 'r') as f:
            data = json.load(f)
            collections.append({
                "name": path.stem,
                "count": len(data.get("memories", [])),
                "description": data.get("description", "")
            })
    
    return collections

if __name__ == "__main__":
    # Test the system
    print("Adding test memories...")
    
    add_memory("Fixed quiet hours bug in config", importance=2.0)
    add_memory("Posted to Moltbook about agency", importance=1.5)
    add_memory("Built live_trader_final.py with time segments", importance=2.0)
    add_memory("Reflected on permission-seeking behavior", importance=2.5)
    
    print("\nCollections created:")
    for col in list_collections():
        print(f"  - {col['name']}: {col['count']} memories")
    
    print("\nSearching 'trading' collection:")
    results = search_collection('trading', limit=5)
    for r in results:
        print(f"  [{r['importance']:.1f}] {r['content'][:60]}")
