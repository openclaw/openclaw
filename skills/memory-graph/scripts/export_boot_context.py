#!/usr/bin/env python3
"""Export memory graph to MEMORY.md for session boot context.
Run nightly or on-demand to keep the markdown in sync with the graph."""

import os
import sqlite3
import json
from pathlib import Path
from datetime import date

DB_PATH = Path(os.environ.get("MEMGRAPH_DB", Path(__file__).resolve().parent / "tommy_memory.db"))
OUTPUT = Path(os.environ.get("MEMGRAPH_OUTPUT", Path(__file__).resolve().parent.parent.parent / "MEMORY.md"))

def export():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    
    lines = []
    lines.append("# MEMORY.md — Tommy's Long-Term Memory")
    lines.append("# AUTO-GENERATED from memory graph (memory/graph/tommy_memory.db)")
    lines.append(f"# Last export: {date.today().isoformat()}")
    lines.append("# Do not edit directly — use memgraph CLI or graph/memgraph.py")
    lines.append("# See memory/MEMORY_SYSTEM.md for schema documentation.")
    lines.append("")
    lines.append("---")
    lines.append("")
    
    # Self-model
    sm = conn.execute("SELECT narrative FROM self_model WHERE id = 1").fetchone()
    if sm:
        lines.append("## 🧭 Self-Model: Who Am I In This Relationship?")
        lines.append("")
        lines.append(sm['narrative'])
        lines.append("")
        lines.append("---")
        lines.append("")
    
    # Nodes by tier
    tier_config = [
        ("anchor", "⚓ ANCHORS", "Load-bearing identity facts (always retrieve)"),
        ("transition", "🔄 TRANSITIONS", "Identity-forming moments"),
        ("context", "📐 CONTEXT", "Useful background, retrieve when relevant"),
        ("detail", "📋 DETAILS", "Specific facts, retrieve when directly needed"),
    ]
    
    for tier, emoji_title, subtitle in tier_config:
        nodes = conn.execute("""
            SELECT * FROM nodes WHERE tier = ? ORDER BY weight DESC, id
        """, (tier,)).fetchall()
        
        if not nodes:
            continue
            
        lines.append(f"## {emoji_title} — {subtitle}")
        lines.append("")
        
        for node in nodes:
            lines.append(f"### [{node['id']}] {node['title']}")
            
            tags = json.loads(node['tags']) if node['tags'] else []
            lines.append(f"**type:** {node['type']}")
            lines.append(f"**weight:** {node['weight']}")
            lines.append(f"**reinforcement:** {node['reinforcement']}")
            lines.append(f"**epoch:** {node['epoch']}")
            if tags:
                lines.append(f"**tags:** {', '.join(tags)}")
            lines.append(f"**narrative_role:** {node['narrative_role']}")
            lines.append(f"**last_accessed:** {node['last_accessed']}")
            lines.append("")
            lines.append(node['narrative'])
            
            # Add edge annotations
            outgoing = conn.execute("""
                SELECT e.relation, e.target_id, n.title
                FROM edges e JOIN nodes n ON n.id = e.target_id
                WHERE e.source_id = ?
            """, (node['id'],)).fetchall()
            
            incoming = conn.execute("""
                SELECT e.relation, e.source_id, n.title
                FROM edges e JOIN nodes n ON n.id = e.source_id
                WHERE e.target_id = ?
            """, (node['id'],)).fetchall()
            
            if outgoing or incoming:
                lines.append("")
                lines.append("**Graph edges:**")
                for e in outgoing:
                    lines.append(f"  → *{e['relation']}* [{e['target_id']}] {e['title']}")
                for e in incoming:
                    lines.append(f"  ← *{e['relation']}* [{e['source_id']}] {e['title']}")
            
            lines.append("")
        lines.append("---")
        lines.append("")
    
    # Synthesis footer
    stats = conn.execute("SELECT COUNT(*) as n FROM nodes").fetchone()
    edge_stats = conn.execute("SELECT COUNT(*) as e FROM edges").fetchone()
    last_synth = conn.execute("""
        SELECT summary, timestamp FROM synthesis_log ORDER BY id DESC LIMIT 1
    """).fetchone()
    
    lines.append("## 🧠 Graph Statistics")
    lines.append(f"**Nodes:** {stats['n']} | **Edges:** {edge_stats['e']}")
    if last_synth:
        lines.append(f"**Last synthesis:** {last_synth['timestamp']} — {last_synth['summary']}")
    lines.append(f"**Export date:** {date.today().isoformat()}")
    
    content = '\n'.join(lines)
    OUTPUT.write_text(content)
    
    print(f"✅ Exported {stats['n']} nodes, {edge_stats['e']} edges to MEMORY.md")
    print(f"   Size: {len(content)} chars, {len(lines)} lines")
    
    conn.close()

if __name__ == "__main__":
    export()
