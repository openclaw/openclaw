#!/usr/bin/env python3
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
# Licensed under MIT
"""
Unified memory search: combines vector search + RAG entity graph.
Usage: python3 unified_search.py "query" [top_k]
"""
import sys
import os
import subprocess
import sqlite3
import re

WORKSPACE = os.path.expanduser("~/.openclaw/workspace")
GRAPH_DB = os.path.expanduser("~/.openclaw/memory/entity_graph.db")

def rag_search(query, limit=10):
    """Search entity graph for entities and relations."""
    if not os.path.exists(GRAPH_DB):
        return None, None
    
    conn = sqlite3.connect(GRAPH_DB)
    
    # FTS search on entities
    # Clean query for FTS
    fts_query = re.sub(r'[^\w\s]', '', query)
    terms = fts_query.split()
    if not terms:
        return [], []
    
    fts_expr = ' OR '.join(terms)
    
    entities = []
    try:
        rows = conn.execute("""
            SELECT e.name, e.type, COUNT(DISTINCT e.chunk_id) as mentions
            FROM entity_fts f
            JOIN entities e ON e.id = f.rowid
            WHERE entity_fts MATCH ?
            GROUP BY e.name, e.type
            ORDER BY mentions DESC
            LIMIT ?
        """, (fts_expr, limit)).fetchall()
        entities = [{"name": r[0], "type": r[1], "mentions": r[2]} for r in rows]
    except Exception:
        pass
    
    # Get relations for found entities
    relations = []
    if entities:
        entity_names = [e["name"] for e in entities[:5]]
        placeholders = ','.join('?' * len(entity_names))
        try:
            rows = conn.execute(f"""
                SELECT DISTINCT subject, predicate, object 
                FROM relations 
                WHERE subject IN ({placeholders}) OR object IN ({placeholders})
                LIMIT 20
            """, entity_names + entity_names).fetchall()
            relations = [{"s": r[0], "p": r[1], "o": r[2]} for r in rows]
        except Exception:
            pass
    
    conn.close()
    return entities, relations

def vector_search(query, top_k=5):
    """Run vector search via existing script."""
    try:
        result = subprocess.run(
            ["python3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "search_history_fast.py"), query, str(top_k)],
            capture_output=True, text=True, timeout=60
        )
        return result.stdout.strip()
    except Exception as e:
        return f"Vector search error: {e}"

def main():
    if len(sys.argv) < 2:
        print("Usage: unified_search.py 'query' [top_k]")
        sys.exit(1)
    
    query = sys.argv[1]
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    
    print(f"🔍 Unified search: \"{query}\"\n")
    
    # 1. RAG entity graph
    print("━━━ Entity Graph ━━━")
    entities, relations = rag_search(query)
    if entities:
        for e in entities[:8]:
            print(f"  [{e['type']}] {e['name']} — {e['mentions']} mentions")
        if relations:
            print(f"\n  Relations ({len(relations)}):")
            for r in relations[:10]:
                print(f"    {r['s']} → {r['p']} → {r['o']}")
    else:
        print("  No entities found.")
    
    # 2. Vector search
    print(f"\n━━━ Vector Search (top {top_k}) ━━━")
    vec_results = vector_search(query, top_k)
    if vec_results:
        print(vec_results)
    else:
        print("  No results.")

if __name__ == "__main__":
    main()
