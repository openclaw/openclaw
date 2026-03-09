#!/usr/bin/env python3
"""Migrate MEMORY.md → SQLite knowledge graph."""

import os
import re
import json
import sqlite3
import sys
from pathlib import Path

WORKSPACE = Path(os.environ.get("MEMGRAPH_WORKSPACE", Path(__file__).resolve().parent.parent.parent))
MEMORY_MD = Path(os.environ.get("MEMGRAPH_MEMORY_MD", WORKSPACE / "MEMORY.md"))
SCHEMA_SQL = Path(os.environ.get("MEMGRAPH_SCHEMA", Path(__file__).resolve().parent / "schema.sql"))
DB_PATH = Path(os.environ.get("MEMGRAPH_DB", Path(__file__).resolve().parent / "tommy_memory.db"))

def parse_memory_md(path):
    content = path.read_text()
    lines = content.split('\n')
    
    # Extract self-model (everything between "## 🧭 Self-Model" and first "## ⚓")
    sm_match = re.search(
        r'## 🧭 Self-Model.*?\n(.*?)(?=\n## [⚓🔄📐📋])',
        content, re.DOTALL
    )
    self_model = sm_match.group(1).strip() if sm_match else ""
    
    # Parse nodes
    nodes = []
    node_pattern = re.compile(r'^### \[([A-Z]\d+)\] (.+)')
    
    node_starts = []
    for i, line in enumerate(lines):
        m = node_pattern.match(line)
        if m:
            node_starts.append((i, m.group(1), m.group(2).strip()))
    
    for idx, (start_line, node_id, title) in enumerate(node_starts):
        end_line = node_starts[idx+1][0] if idx+1 < len(node_starts) else len(lines)
        block = '\n'.join(lines[start_line+1:end_line]).strip()
        
        # Parse metadata fields
        def extract(field, default=""):
            m = re.search(rf'\*\*{field}:\*\*\s*(.+)', block)
            return m.group(1).strip() if m else default
        
        node_type = extract('type', 'episodic')
        weight = int(extract('weight', '5'))
        reinforcement = int(extract('reinforcement', '1'))
        epoch = extract('epoch', 'founding')
        tags_str = extract('tags', '')
        narrative_role = extract('narrative_role', 'detail')
        last_accessed = extract('last_accessed', '2026-03-09')
        
        # Determine tier from ID prefix
        tier_map = {'A': 'anchor', 'T': 'transition', 'C': 'context', 'D': 'detail'}
        tier = tier_map.get(node_id[0], 'detail')
        
        # Parse tags into JSON array
        tags = [t.strip() for t in tags_str.split(',') if t.strip()]
        
        # Extract narrative (everything after metadata lines)
        narrative_lines = []
        past_metadata = False
        for line in block.split('\n'):
            if line.startswith('**') and ':**' in line:
                continue  # Skip metadata lines
            narrative_lines.append(line)
        narrative = '\n'.join(narrative_lines).strip()
        
        # Find cross-references within this block
        refs = re.findall(r'\[([A-Z]\d+)\]', block)
        cross_refs = [r for r in refs if r != node_id]
        
        nodes.append({
            'id': node_id,
            'title': title,
            'narrative': narrative,
            'type': node_type,
            'tier': tier,
            'weight': weight,
            'reinforcement': reinforcement,
            'epoch': epoch,
            'tags': json.dumps(tags),
            'narrative_role': narrative_role,
            'last_accessed': last_accessed,
            'cross_refs': cross_refs
        })
    
    return self_model, nodes

def infer_edge_type(source, target, context_text):
    """Infer edge relation from context. Default to 'references'."""
    text = context_text.lower()
    if any(w in text for w in ['corrected', 'lesson', 'taught', 'correction']):
        return 'taught_by'
    if any(w in text for w in ['led to', 'enabled', 'caused', 'resulted']):
        return 'led_to'
    if any(w in text for w in ['support', 'evidence', 'proves', 'validates']):
        return 'supports'
    if any(w in text for w in ['part of', 'component', 'within']):
        return 'part_of'
    if any(w in text for w in ['became', 'evolved', 'grew into']):
        return 'evolved_to'
    if any(w in text for w in ['deepens', 'elaborat', 'adds depth']):
        return 'deepens'
    if any(w in text for w in ['contradict', 'tension', 'conflict']):
        return 'contradicts'
    return 'references'

def migrate():
    print(f"Source: {MEMORY_MD}")
    print(f"Target: {DB_PATH}")
    
    # Parse
    self_model, nodes = parse_memory_md(MEMORY_MD)
    print(f"Parsed: {len(nodes)} nodes, self-model: {len(self_model)} chars")
    
    # Build valid node IDs set for edge validation
    valid_ids = {n['id'] for n in nodes}
    
    # Create DB
    if DB_PATH.exists():
        DB_PATH.unlink()
    
    conn = sqlite3.connect(str(DB_PATH))
    conn.executescript(SCHEMA_SQL.read_text())
    
    # Insert nodes
    for node in nodes:
        conn.execute("""
            INSERT INTO nodes (id, title, narrative, type, tier, weight, 
                             reinforcement, epoch, tags, narrative_role, last_accessed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            node['id'], node['title'], node['narrative'],
            node['type'], node['tier'], node['weight'],
            node['reinforcement'], node['epoch'], node['tags'],
            node['narrative_role'], node['last_accessed']
        ))
    
    # Insert edges
    edge_count = 0
    for node in nodes:
        for ref in node['cross_refs']:
            if ref in valid_ids:
                relation = infer_edge_type(node['id'], ref, node['narrative'])
                try:
                    conn.execute("""
                        INSERT OR IGNORE INTO edges (source_id, target_id, relation)
                        VALUES (?, ?, ?)
                    """, (node['id'], ref, relation))
                    edge_count += 1
                except sqlite3.IntegrityError:
                    pass
    
    # Insert self-model
    conn.execute("""
        INSERT INTO self_model (id, narrative) VALUES (1, ?)
    """, (self_model,))
    
    # Log the migration
    node_ids = [n['id'] for n in nodes]
    conn.execute("""
        INSERT INTO synthesis_log (summary, nodes_added, edges_added)
        VALUES (?, ?, ?)
    """, (
        f"Initial migration from MEMORY.md: {len(nodes)} nodes, {edge_count} edges",
        json.dumps(node_ids),
        edge_count
    ))
    
    conn.commit()
    
    # Verify
    row = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()
    edge_row = conn.execute("SELECT COUNT(*) FROM edges").fetchone()
    fts_row = conn.execute("SELECT COUNT(*) FROM nodes_fts").fetchone()
    
    print(f"\n✅ Migration complete:")
    print(f"   Nodes: {row[0]}")
    print(f"   Edges: {edge_row[0]}")
    print(f"   FTS entries: {fts_row[0]}")
    print(f"   Self-model: loaded")
    print(f"   DB size: {DB_PATH.stat().st_size / 1024:.1f} KB")
    
    # Show edge type distribution
    for row in conn.execute("SELECT relation, COUNT(*) FROM edges GROUP BY relation ORDER BY COUNT(*) DESC"):
        print(f"   Edge type '{row[0]}': {row[1]}")
    
    # Quick FTS test
    results = conn.execute("""
        SELECT id, title FROM nodes_fts WHERE nodes_fts MATCH 'Lisa'
    """).fetchall()
    print(f"\n   FTS test 'Lisa': {len(results)} results — {[r[0] for r in results]}")
    
    conn.close()

if __name__ == "__main__":
    migrate()
