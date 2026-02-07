#!/usr/bin/env python3
"""
Embeddings Manager - Phase 3 of Cortex Memory System

SQLite-based vector search with temporal weighting.
Provides semantic search across all memory sources.

Data directory can be configured via CORTEX_DATA_DIR environment variable.
"""
import sqlite3
import json
import hashlib
import os
from datetime import datetime, timedelta
from pathlib import Path

# Data directory: use CORTEX_DATA_DIR env var or default to script directory
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).parent))
DB_PATH = DATA_DIR / ".embeddings.db"

def init_db():
    """Initialize embeddings database"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    c.execute('''
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            category TEXT,
            timestamp TEXT NOT NULL,
            importance REAL DEFAULT 1.0,
            access_count INTEGER DEFAULT 0,
            embedding_text TEXT
        )
    ''')
    
    c.execute('''
        CREATE INDEX IF NOT EXISTS idx_timestamp ON memories(timestamp)
    ''')
    
    c.execute('''
        CREATE INDEX IF NOT EXISTS idx_category ON memories(category)
    ''')
    
    c.execute('''
        CREATE INDEX IF NOT EXISTS idx_source ON memories(source)
    ''')
    
    conn.commit()
    conn.close()

def memory_id(content, timestamp):
    """Generate deterministic ID for a memory"""
    return hashlib.sha256(f"{content}{timestamp}".encode()).hexdigest()[:16]

def add_memory(content, source="manual", category=None, importance=1.0, timestamp=None):
    """Add a memory to the database"""
    if timestamp is None:
        timestamp = datetime.now().isoformat()
    
    mem_id = memory_id(content, timestamp)
    
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    c.execute('''
        INSERT OR REPLACE INTO memories (id, content, source, category, timestamp, importance, embedding_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (mem_id, content, source, category, timestamp, importance, content.lower()))
    
    conn.commit()
    conn.close()
    
    return mem_id

def search_memories(query, limit=10, temporal_weight=0.7, date_range=None, category=None):
    """
    Search memories with temporal weighting.
    
    Args:
        query: Search query string
        limit: Max results to return
        temporal_weight: 0-1, weight given to recency (vs semantic match)
        date_range: Tuple of (start_date, end_date) or special strings like "last_week"
        category: Filter by category
    
    Returns:
        List of matching memories with scores
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # Build query
    sql = "SELECT id, content, source, category, timestamp, importance, access_count FROM memories WHERE 1=1"
    params = []
    
    if category:
        sql += " AND category = ?"
        params.append(category)
    
    if date_range:
        if isinstance(date_range, str):
            # Parse special date ranges
            now = datetime.now()
            if date_range == "today":
                start = now.replace(hour=0, minute=0, second=0)
                end = now
            elif date_range == "yesterday":
                start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0)
                end = now.replace(hour=0, minute=0, second=0)
            elif date_range == "last_week":
                start = now - timedelta(days=7)
                end = now
            elif date_range == "last_month":
                start = now - timedelta(days=30)
                end = now
            else:
                start = end = None
            
            if start and end:
                sql += " AND timestamp >= ? AND timestamp <= ?"
                params.extend([start.isoformat(), end.isoformat()])
        elif isinstance(date_range, tuple):
            sql += " AND timestamp >= ? AND timestamp <= ?"
            params.extend(date_range)
    
    # Simple text search (exact match in content)
    if query:
        sql += " AND LOWER(content) LIKE ?"
        params.append(f"%{query.lower()}%")
    
    c.execute(sql, params)
    results = c.fetchall()
    
    # Score results with temporal weighting
    now = datetime.now()
    scored = []
    
    for row in results:
        mem_id, content, source, cat, timestamp, importance, access_count = row
        
        # Parse timestamp
        ts = datetime.fromisoformat(timestamp)
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)
        
        # Recency score: 1.0 for today, decaying
        days_ago = (now - ts).days + 1
        recency_score = 1.0 / days_ago
        
        # Semantic score: simple keyword match (in real impl, use embeddings)
        if query:
            query_words = set(query.lower().split())
            content_words = set(content.lower().split())
            semantic_score = len(query_words & content_words) / max(len(query_words), 1)
        else:
            semantic_score = 1.0
        
        # Combined score
        final_score = (semantic_score * (1 - temporal_weight)) + (recency_score * temporal_weight)
        final_score *= importance  # Boost by importance
        
        scored.append({
            "id": mem_id,
            "content": content,
            "source": source,
            "category": cat,
            "timestamp": timestamp,
            "importance": importance,
            "access_count": access_count,
            "score": final_score,
            "recency_score": recency_score,
            "semantic_score": semantic_score
        })
    
    # Sort by score
    scored.sort(key=lambda x: x["score"], reverse=True)
    
    # Update access counts
    for item in scored[:limit]:
        c.execute("UPDATE memories SET access_count = access_count + 1 WHERE id = ?", (item["id"],))
    
    conn.commit()
    conn.close()
    
    return scored[:limit]

def sync_from_collections():
    """Import memories from collections into embeddings DB"""
    from collections_manager import list_collections, load_collection
    
    count = 0
    for col_info in list_collections():
        collection = load_collection(col_info["name"])
        for memory in collection.get("memories", []):
            add_memory(
                content=memory["content"],
                source=f"collection:{col_info['name']}",
                category=col_info["name"],
                importance=memory.get("importance", 1.0),
                timestamp=memory["timestamp"]
            )
            count += 1
    
    return count

def sync_from_stm():
    """Import STM into embeddings DB"""
    from stm_manager import load_stm
    
    stm = load_stm()
    count = 0
    
    for item in stm.get("short_term_memory", []):
        add_memory(
            content=item["content"],
            source="stm",
            category=item.get("category"),
            importance=item.get("importance", 1.0),
            timestamp=item["timestamp"]
        )
        count += 1
    
    return count

def stats():
    """Get database statistics"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    c.execute("SELECT COUNT(*) FROM memories")
    total = c.fetchone()[0]
    
    c.execute("SELECT category, COUNT(*) FROM memories GROUP BY category")
    by_category = dict(c.fetchall())
    
    c.execute("SELECT source, COUNT(*) FROM memories GROUP BY source")
    by_source = dict(c.fetchall())
    
    conn.close()
    
    return {
        "total": total,
        "by_category": by_category,
        "by_source": by_source
    }

if __name__ == "__main__":
    print("Initializing embeddings database...")
    init_db()
    
    print("Syncing from STM...")
    stm_count = sync_from_stm()
    print(f"  Added {stm_count} memories from STM")
    
    print("Syncing from collections...")
    col_count = sync_from_collections()
    print(f"  Added {col_count} memories from collections")
    
    print("\nDatabase stats:")
    s = stats()
    print(f"  Total memories: {s['total']}")
    print(f"  By category: {s['by_category']}")
    print(f"  By source: {s['by_source']}")
    
    print("\nTesting search...")
    results = search_memories("trading bot", limit=5, temporal_weight=0.7)
    print(f"Found {len(results)} results for 'trading bot':")
    for r in results:
        print(f"  [{r['score']:.3f}] {r['content'][:60]}...")
    
    print("\nTesting date range search...")
    results = search_memories("", date_range="today", limit=5)
    print(f"Found {len(results)} memories from today:")
    for r in results:
        print(f"  {r['content'][:60]}...")
