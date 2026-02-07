#!/usr/bin/env python3
"""
Local Embeddings using sentence-transformers on RTX 5090
Replaces API-based embeddings for Cortex
"""
import os
import json
import sqlite3
import numpy as np
from pathlib import Path
from datetime import datetime

# Model selection - all-MiniLM-L6-v2 is fast and good quality
MODEL_NAME = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384

# Singleton model instance
_model = None

def get_model():
    """Lazy load the model"""
    global _model
    if _model is None:
        print(f"🔥 Loading {MODEL_NAME} on GPU...")
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME, device="cuda")
        print(f"✅ Model loaded!")
    return _model

def embed(texts):
    """Generate embeddings for a list of texts"""
    model = get_model()
    if isinstance(texts, str):
        texts = [texts]
    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
    return embeddings

def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors"""
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

# Database setup
DB_PATH = Path(__file__).parent / ".local_embeddings.db"

def init_db():
    """Initialize the embeddings database"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS embeddings (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            category TEXT,
            importance REAL DEFAULT 1.0,
            timestamp TEXT,
            embedding BLOB NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category ON embeddings(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON embeddings(timestamp)")
    conn.commit()
    conn.close()

def store(content, category=None, importance=1.0, timestamp=None):
    """Store a memory with its embedding"""
    init_db()
    embedding = embed(content)[0]
    memory_id = f"{hash(content + str(timestamp))}"
    
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        INSERT OR REPLACE INTO embeddings (id, content, category, importance, timestamp, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (memory_id, content, category, importance, timestamp or datetime.now().isoformat(), 
          embedding.tobytes()))
    conn.commit()
    conn.close()
    return memory_id

def search(query, limit=5, category=None, temporal_weight=0.3):
    """Search memories using semantic similarity"""
    init_db()
    query_embedding = embed(query)[0]
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    if category:
        cursor.execute("SELECT id, content, category, importance, timestamp, embedding FROM embeddings WHERE category = ?", (category,))
    else:
        cursor.execute("SELECT id, content, category, importance, timestamp, embedding FROM embeddings")
    
    results = []
    now = datetime.now()
    
    for row in cursor.fetchall():
        id_, content, cat, importance, timestamp, emb_bytes = row
        embedding = np.frombuffer(emb_bytes, dtype=np.float32)
        
        # Semantic similarity
        semantic_score = cosine_similarity(query_embedding, embedding)
        
        # Temporal score (exponential decay)
        try:
            ts = datetime.fromisoformat(timestamp.replace('Z', '+00:00').replace('+00:00', ''))
            days_old = (now - ts).total_seconds() / 86400
            temporal_score = np.exp(-days_old / 7)  # Half-life of ~1 week
        except:
            temporal_score = 0.5
        
        # Combined score
        importance_weight = 0.2
        semantic_weight = 1.0 - temporal_weight - importance_weight
        final_score = (semantic_score * semantic_weight + 
                      temporal_score * temporal_weight + 
                      (importance / 3.0) * importance_weight)
        
        results.append({
            'id': id_,
            'content': content,
            'category': cat,
            'importance': importance,
            'timestamp': timestamp,
            'score': final_score,
            'semantic_score': semantic_score,
            'temporal_score': temporal_score
        })
    
    conn.close()
    
    # Sort by score and return top results
    results.sort(key=lambda x: x['score'], reverse=True)
    return results[:limit]

def sync_from_collections():
    """Sync all memories from collections to embeddings DB"""
    from collections_manager import list_collections, load_collection
    
    collections = list_collections()
    total = 0
    
    for c in collections:
        data = load_collection(c['name'])
        for mem in data.get('memories', []):
            store(
                content=mem.get('content', ''),
                category=c['name'],
                importance=mem.get('importance', 1.0),
                timestamp=mem.get('timestamp')
            )
            total += 1
    
    return total

def stats():
    """Get stats about the embeddings DB"""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) FROM embeddings")
    total = cursor.fetchone()[0]
    
    cursor.execute("SELECT category, COUNT(*) FROM embeddings GROUP BY category")
    by_category = dict(cursor.fetchall())
    
    conn.close()
    
    return {
        'total': total,
        'by_category': by_category,
        'model': MODEL_NAME,
        'embedding_dim': EMBEDDING_DIM
    }

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        if sys.argv[1] == "sync":
            print("🔄 Syncing from collections...")
            count = sync_from_collections()
            print(f"✅ Synced {count} memories")
        elif sys.argv[1] == "stats":
            s = stats()
            print(f"📊 Local Embeddings Stats:")
            print(f"   Model: {s['model']}")
            print(f"   Total: {s['total']}")
            print(f"   By category: {s['by_category']}")
        elif sys.argv[1] == "search":
            query = " ".join(sys.argv[2:])
            print(f"🔍 Searching: {query}")
            results = search(query)
            for r in results:
                print(f"  [{r['score']:.3f}] [{r['importance']:.1f}] {r['content'][:60]}...")
    else:
        print("Usage: python local_embeddings.py [sync|stats|search <query>]")
