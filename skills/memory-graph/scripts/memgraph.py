#!/usr/bin/env python3
"""Tommy's Memory Graph — CLI interface for querying and updating the knowledge graph."""

import os
import sqlite3
import json
import sys
from pathlib import Path
from datetime import date

DB_PATH = Path(os.environ.get("MEMGRAPH_DB", Path(__file__).resolve().parent / "tommy_memory.db"))

def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def cmd_search(query):
    """Full-text search across all nodes."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT n.id, n.title, n.tier, n.weight, n.reinforcement, n.last_accessed,
               highlight(nodes_fts, 2, '>>>', '<<<') as snippet
        FROM nodes_fts f
        JOIN nodes n ON n.id = f.id
        WHERE nodes_fts MATCH ?
        ORDER BY n.weight DESC, rank
    """, (query,)).fetchall()
    
    for r in rows:
        print(f"[{r['id']}] (w={r['weight']}, r={r['reinforcement']}, {r['tier']}) {r['title']}")
    
    # Touch reinforcement on retrieved nodes
    today = date.today().isoformat()
    for r in rows:
        conn.execute("""
            UPDATE nodes SET reinforcement = reinforcement + 1, last_accessed = ?
            WHERE id = ? AND last_accessed != ?
        """, (today, r['id'], today))
    conn.commit()
    conn.close()

def cmd_node(node_id):
    """Get a single node with its edges."""
    conn = get_conn()
    node = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if not node:
        print(f"Node {node_id} not found")
        return
    
    print(f"### [{node['id']}] {node['title']}")
    print(f"tier={node['tier']} type={node['type']} weight={node['weight']} "
          f"reinforcement={node['reinforcement']} epoch={node['epoch']}")
    print(f"tags: {node['tags']}")
    print(f"last_accessed: {node['last_accessed']}")
    print(f"\n{node['narrative']}")
    
    # Edges
    outgoing = conn.execute("""
        SELECT e.relation, e.target_id, n.title 
        FROM edges e JOIN nodes n ON n.id = e.target_id
        WHERE e.source_id = ?
    """, (node_id,)).fetchall()
    
    incoming = conn.execute("""
        SELECT e.relation, e.source_id, n.title
        FROM edges e JOIN nodes n ON n.id = e.source_id  
        WHERE e.target_id = ?
    """, (node_id,)).fetchall()
    
    if outgoing:
        print(f"\n→ Outgoing edges:")
        for e in outgoing:
            print(f"  --{e['relation']}--> [{e['target_id']}] {e['title']}")
    if incoming:
        print(f"\n← Incoming edges:")
        for e in incoming:
            print(f"  <--{e['relation']}-- [{e['source_id']}] {e['title']}")
    
    # Touch
    today = date.today().isoformat()
    conn.execute("UPDATE nodes SET reinforcement = reinforcement + 1, last_accessed = ? WHERE id = ?",
                 (today, node_id))
    conn.commit()
    conn.close()

def cmd_anchors():
    """Retrieve all anchor-tier nodes (always load)."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT id, title, weight, reinforcement, last_accessed
        FROM nodes WHERE tier = 'anchor' ORDER BY weight DESC
    """).fetchall()
    for r in rows:
        print(f"[{r['id']}] (w={r['weight']}, r={r['reinforcement']}) {r['title']}")
    conn.close()

def cmd_neighbors(node_id, depth=1):
    """Get all nodes within N hops of a given node."""
    conn = get_conn()
    visited = set()
    frontier = {node_id}
    
    for d in range(depth):
        next_frontier = set()
        for nid in frontier:
            if nid in visited:
                continue
            visited.add(nid)
            # Outgoing
            for row in conn.execute("SELECT target_id FROM edges WHERE source_id = ?", (nid,)):
                next_frontier.add(row['target_id'])
            # Incoming
            for row in conn.execute("SELECT source_id FROM edges WHERE target_id = ?", (nid,)):
                next_frontier.add(row['source_id'])
        frontier = next_frontier - visited
    visited.update(frontier)
    visited.discard(node_id)
    
    if visited:
        placeholders = ','.join('?' * len(visited))
        rows = conn.execute(f"""
            SELECT id, title, tier, weight FROM nodes 
            WHERE id IN ({placeholders}) ORDER BY weight DESC
        """, list(visited)).fetchall()
        for r in rows:
            print(f"[{r['id']}] ({r['tier']}, w={r['weight']}) {r['title']}")
    else:
        print(f"No neighbors found for {node_id}")
    conn.close()

def cmd_stats():
    """Database statistics."""
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    edges = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    
    print(f"Nodes: {total}, Edges: {edges}")
    print(f"DB size: {DB_PATH.stat().st_size / 1024:.1f} KB")
    
    print("\nBy tier:")
    for row in conn.execute("SELECT tier, COUNT(*) as c FROM nodes GROUP BY tier ORDER BY c DESC"):
        print(f"  {row['tier']}: {row['c']}")
    
    print("\nBy edge type:")
    for row in conn.execute("SELECT relation, COUNT(*) as c FROM edges GROUP BY relation ORDER BY c DESC"):
        print(f"  {row['relation']}: {row['c']}")
    
    print("\nMost connected (top 10):")
    rows = conn.execute("""
        SELECT n.id, n.title,
            (SELECT COUNT(*) FROM edges WHERE source_id = n.id) +
            (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as degree
        FROM nodes n ORDER BY degree DESC LIMIT 10
    """).fetchall()
    for r in rows:
        print(f"  [{r['id']}] degree={r['degree']} — {r['title']}")
    
    print("\nStale nodes (last_accessed > 14 days ago):")
    rows = conn.execute("""
        SELECT id, title, last_accessed FROM nodes 
        WHERE last_accessed < date('now', '-14 days')
        ORDER BY last_accessed ASC LIMIT 10
    """).fetchall()
    for r in rows:
        print(f"  [{r['id']}] {r['last_accessed']} — {r['title']}")
    
    conn.close()

def cmd_add(node_id, title, narrative, type_, tier, weight, epoch, tags, narrative_role):
    """Add a new node."""
    conn = get_conn()
    conn.execute("""
        INSERT INTO nodes (id, title, narrative, type, tier, weight, epoch, tags, narrative_role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (node_id, title, narrative, type_, tier, int(weight), epoch, json.dumps(tags.split(',')), narrative_role))
    conn.commit()
    print(f"✅ Added [{node_id}] {title}")
    conn.close()

def cmd_link(source, target, relation, context=None):
    """Add an edge between nodes."""
    conn = get_conn()
    conn.execute("""
        INSERT OR REPLACE INTO edges (source_id, target_id, relation, context)
        VALUES (?, ?, ?, ?)
    """, (source, target, relation, context))
    conn.commit()
    print(f"✅ [{source}] --{relation}--> [{target}]")
    conn.close()

def cmd_self_model():
    """Show the self-model narrative."""
    conn = get_conn()
    row = conn.execute("SELECT narrative, updated_at FROM self_model WHERE id = 1").fetchone()
    if row:
        print(f"Updated: {row['updated_at']}\n")
        print(row['narrative'])
    conn.close()

if __name__ == "__main__":
    commands = {
        'search': lambda args: cmd_search(' '.join(args)),
        'node': lambda args: cmd_node(args[0]),
        'anchors': lambda args: cmd_anchors(),
        'neighbors': lambda args: cmd_neighbors(args[0], int(args[1]) if len(args) > 1 else 1),
        'stats': lambda args: cmd_stats(),
        'self-model': lambda args: cmd_self_model(),
        'add': lambda args: cmd_add(*args[:9]),
        'link': lambda args: cmd_link(*args[:4]),
    }
    
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        print(f"Usage: memgraph <{'|'.join(commands.keys())}> [args...]")
        sys.exit(1)
    
    commands[sys.argv[1]](sys.argv[2:])
