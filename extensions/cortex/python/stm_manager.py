#!/usr/bin/env python3
"""
Short-Term Memory (STM) Manager — brain.db backend

Thin wrapper around UnifiedBrain.remember() / get_stm().
Same API as the original stm.json-based manager for backward compat.

All reads/writes go to brain.db (WAL mode, FTS5 indexed).
"""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

# Data directory
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).parent))

# Import UnifiedBrain (same directory)
from brain import UnifiedBrain

# Singleton brain instance
_brain = None

def _get_brain() -> UnifiedBrain:
    global _brain
    if _brain is None:
        _brain = UnifiedBrain()  # Uses brain.py's default path (~/.openclaw/workspace/memory/brain.db)
    return _brain


def load_stm():
    """Load STM — returns format compatible with old stm.json consumers."""
    b = _get_brain()
    items = b.get_stm(limit=50000)  # Get all (capacity handled by caller)
    return {
        "short_term_memory": [_brain_to_stm_item(i) for i in items],
        "capacity": 50000,
        "auto_expire_days": 30,
        "last_cleanup": None,
    }


def save_stm(stm):
    """No-op — brain.db handles persistence. Kept for backward compat."""
    pass


def add_to_stm(content, category=None, categories=None, importance=1.0):
    """Add item to STM via brain.db."""
    b = _get_brain()

    # Normalize categories
    if categories is not None:
        cats = categories if isinstance(categories, list) else [categories]
    elif category is not None:
        cats = [category] if isinstance(category, str) else category
    else:
        cats = ["general"]

    mem_id = b.remember(content, categories=cats, importance=importance, source="agent")

    item = {
        "id": mem_id,
        "content": content,
        "timestamp": datetime.now().isoformat(),
        "categories": cats,
        "category": cats[0] if cats else "general",
        "importance": importance,
        "access_count": 0,
    }
    return item


def get_recent(limit=10, category=None, categories=None):
    """Get recent STM items from brain.db."""
    b = _get_brain()

    # Determine filter category (brain.db supports single category filter)
    filter_cat = None
    if categories is not None:
        filter_cats = categories if isinstance(categories, list) else [categories]
        filter_cat = filter_cats[0] if filter_cats else None
    elif category is not None:
        filter_cat = category

    items = b.get_stm(limit=limit, category=filter_cat)

    # Convert to legacy format
    result = []
    for item in items:
        result.append(_brain_to_stm_item(item))
    return result


def delete_stm_batch(memory_ids):
    """Delete multiple STM entries by ID. Returns count deleted."""
    b = _get_brain()
    return b.delete_stm_batch(memory_ids)


def cleanup_expired():
    """No-op — brain.db doesn't auto-expire. Kept for backward compat."""
    return 0


def _brain_to_stm_item(item: dict) -> dict:
    """Convert brain.db STM dict to legacy stm.json format."""
    cats = item.get("categories", ["general"])
    if isinstance(cats, str):
        try:
            cats = json.loads(cats)
        except (json.JSONDecodeError, TypeError):
            cats = [cats]

    return {
        "id": item.get("id", ""),
        "content": item.get("content", ""),
        "timestamp": item.get("created_at", datetime.now().isoformat()),
        "categories": cats,
        "category": cats[0] if cats else "general",
        "importance": item.get("importance", 1.0),
        "access_count": item.get("access_count", 0),
    }


if __name__ == "__main__":
    # Test
    add_to_stm("System started", category="system", importance=1.0)
    add_to_stm("Found quiet hours bug in config", category="debug", importance=2.0)

    print("Recent STM items:")
    for item in get_recent(limit=5):
        print(f"- [{item['category']}] {item['content'][:60]}")

    print(f"\nCleaned up {cleanup_expired()} expired items")
