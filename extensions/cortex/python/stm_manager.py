#!/usr/bin/env python3
"""
Short-Term Memory (STM) Manager

Implements Cortex-style dual-tier memory:
- STM: Last 10-20 significant events (fast access)
- LTM: Daily markdown files + collections (persistent)

STM auto-expires to daily logs AND collections after 7 days.

Data directory can be configured via CORTEX_DATA_DIR environment variable.
Defaults to the script's directory for backward compatibility.
"""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

try:
    from collections_manager import add_memory as add_to_collection
    COLLECTIONS_ENABLED = True
except ImportError:
    COLLECTIONS_ENABLED = False

# Data directory: use CORTEX_DATA_DIR env var or default to script directory
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).parent))
STM_PATH = DATA_DIR / "stm.json"

def load_stm():
    """Load short-term memory"""
    if STM_PATH.exists():
        with open(STM_PATH, 'r') as f:
            return json.load(f)
    return {
        "short_term_memory": [],
        "capacity": 20,
        "auto_expire_days": 7,
        "last_cleanup": None
    }

def save_stm(stm):
    """Save short-term memory"""
    with open(STM_PATH, 'w') as f:
        json.dump(stm, f, indent=2)

def add_to_stm(content, category=None, categories=None, importance=1.0):
    """Add item to short-term memory

    PHASE 3: Multi-category support
    - categories: list of category strings (preferred)
    - category: single category string (deprecated, for backward compat)
    """
    stm = load_stm()

    # Normalize categories: prefer categories list, fall back to single category
    if categories is not None:
        cats = categories if isinstance(categories, list) else [categories]
    elif category is not None:
        cats = [category] if isinstance(category, str) else category
    else:
        cats = ["general"]

    item = {
        "content": content,
        "timestamp": datetime.now().isoformat(),
        "categories": cats,  # PHASE 3: Multi-category
        "category": cats[0] if cats else "general",  # Backward compat
        "importance": importance,
        "access_count": 0
    }

    # Add to beginning (most recent first)
    stm["short_term_memory"].insert(0, item)

    # Trim if over capacity
    if len(stm["short_term_memory"]) > stm["capacity"]:
        # Keep high-importance items, expire low-importance
        stm["short_term_memory"] = sorted(
            stm["short_term_memory"],
            key=lambda x: x["importance"],
            reverse=True
        )[:stm["capacity"]]

    save_stm(stm)
    return item

def get_recent(limit=10, category=None, categories=None):
    """Get recent items from STM

    PHASE 3: Multi-category filtering support
    - categories: list of categories to filter by (any match)
    - category: single category (deprecated)
    """
    stm = load_stm()
    items = stm["short_term_memory"]

    # Determine filter categories
    filter_cats = None
    if categories is not None:
        filter_cats = categories if isinstance(categories, list) else [categories]
    elif category is not None:
        filter_cats = [category]

    if filter_cats:
        def matches(item):
            # Get item's categories (handle both old and new format)
            item_cats = item.get("categories", [item.get("category", "general")])
            if isinstance(item_cats, str):
                item_cats = [item_cats]
            # Check if any item category matches any filter category
            return any(ic in filter_cats for ic in item_cats)
        items = [i for i in items if matches(i)]

    # Update access counts
    for item in items[:limit]:
        item["access_count"] += 1
    save_stm(stm)

    return items[:limit]

def cleanup_expired():
    """Move expired items to daily logs"""
    stm = load_stm()
    now = datetime.now()
    expire_date = now - timedelta(days=stm["auto_expire_days"])
    
    kept = []
    expired = []
    
    for item in stm["short_term_memory"]:
        ts = datetime.fromisoformat(item["timestamp"])
        if ts > expire_date or item.get("importance", 0) >= 2.0:
            kept.append(item)
        else:
            expired.append(item)
    
    # Archive expired items to daily log AND collections
    if expired:
        for item in expired:
            ts = datetime.fromisoformat(item["timestamp"])
            daily_file = DATA_DIR / f"{ts.strftime('%Y-%m-%d')}.md"
            
            # Add to daily log
            with open(daily_file, 'a') as f:
                f.write(f"\n## Archived from STM\n")
                f.write(f"**Time:** {ts.strftime('%H:%M:%S')}\n")
                f.write(f"**Category:** {item.get('category', 'general')}\n")
                f.write(f"{item['content']}\n\n")
            
            # Add to collections (if enabled)
            if COLLECTIONS_ENABLED:
                try:
                    add_to_collection(
                        content=item['content'],
                        importance=item.get('importance', 1.0),
                        force_category=item.get('category')
                    )
                except Exception as e:
                    print(f"Warning: Failed to add to collection: {e}")
    
    stm["short_term_memory"] = kept
    stm["last_cleanup"] = now.isoformat()
    save_stm(stm)
    
    return len(expired)

if __name__ == "__main__":
    # Test
    add_to_stm("System started", category="system", importance=1.0)
    add_to_stm("Found quiet hours bug in config", category="debug", importance=2.0)
    
    print("Recent STM items:")
    for item in get_recent(limit=5):
        print(f"- [{item['category']}] {item['content'][:60]}")
    
    print(f"\nCleaned up {cleanup_expired()} expired items")
