#!/usr/bin/env python3
"""
Graph Query Tool — Query the knowledge graph for architecture insights.

Usage:
    python3 scripts/graph-query.py --callers FUNC
    python3 scripts/graph-query.py --path START END
    python3 scripts/graph-query.py --edges-from NODE
    python3 scripts/graph-query.py --edges-to NODE
    python3 scripts/graph-query.py --community NUM
    python3 scripts/graph-query.py --related-to TERM
    python3 scripts/graph-query.py --test-coverage FUNC

Requirements:
    - graph.json in graphify-out/ directory
    - Python 3.10+
"""

import argparse
import json
import sys
from collections import deque
from pathlib import Path


def load_graph():
    """Load graph.json from current directory or parent."""
    for path in ['graphify-out/graph.json', '../graphify-out/graph.json']:
        p = Path(path)
        if p.exists():
            with open(p) as f:
                data = json.load(f)
            # Handle NetworkX JSON format
            if 'nodes' in data and 'links' in data:
                return data
    print("ERROR: graph.json not found. Run 'graphify .' first.", file=sys.stderr)
    sys.exit(1)


def find_nodes_matching(graph_data, term, limit=20):
    """Find nodes whose label matches the term."""
    nodes = graph_data['nodes']
    term_lower = term.lower()
    scored = []
    for n in nodes:
        label = n.get('label', '').lower()
        score = sum(1 for w in term.split() if w in label)
        if score > 0:
            scored.append((score, n))
    scored.sort(reverse=True)
    return [n for _, n in scored[:limit]]


def find_callers(graph_data, func_name):
    """Find all nodes that call the specified function."""
    nodes = graph_data['nodes']
    links = graph_data['links']
    
    # Build node map
    node_map = {n['id']: n for n in nodes}
    
    # Find edges where target matches function
    callers = []
    func_lower = func_name.lower()
    for l in links:
        target = l.get('target', '').lower()
        if func_lower in target and l.get('relation') == 'calls':
            source = l.get('source')
            if source in node_map:
                callers.append(node_map[source])
    
    return callers


def find_path(graph_data, start_term, end_term, max_depth=5):
    """Find shortest path between two concepts."""
    nodes = graph_data['nodes']
    links = graph_data['links']
    
    # Build adjacency
    adj = {}
    for n in nodes:
        adj[n['id']] = []
    for l in links:
        src, tgt = l.get('source'), l.get('target')
        if src in adj and tgt in adj:
            adj[src].append((tgt, l))
    
    # Find start and end nodes
    start_nodes = find_nodes_matching(graph_data, start_term, limit=3)
    end_nodes = find_nodes_matching(graph_data, end_term, limit=3)
    
    if not start_nodes:
        print(f"Could not find node matching: {start_term}")
        return
    if not end_nodes:
        print(f"Could not find node matching: {end_term}")
        return
    
    results = []
    for start in start_nodes[:2]:
        for end in end_nodes[:2]:
            if start['id'] == end['id']:
                continue
            path = bfs_path(adj, start['id'], end['id'], max_depth)
            if path:
                results.append((start, end, path))
    
    return results


def bfs_path(adj, start, end, max_depth):
    """BFS to find shortest path."""
    visited = {start}
    queue = deque([(start, [start])])
    
    while queue:
        node, path = queue.popleft()
        if len(path) > max_depth + 1:
            continue
        
        if node == end:
            return path
        
        for neighbor, _ in adj.get(node, []):
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, path + [neighbor]))
    
    return None


def find_edges_from(graph_data, node_term, direction='out'):
    """Find all edges from or to a node."""
    nodes = graph_data['nodes']
    links = graph_data['links']
    
    node_map = {n['id']: n for n in nodes}
    matched = find_nodes_matching(graph_data, node_term, limit=5)
    
    if not matched:
        print(f"No nodes matching: {node_term}")
        return
    
    results = []
    for n in matched[:3]:
        nid = n['id']
        for l in links:
            if direction == 'out' and l.get('source') == nid:
                results.append((n, l, node_map.get(l.get('target'), {})))
            elif direction == 'in' and l.get('target') == nid:
                results.append((n, l, node_map.get(l.get('source'), {})))
    
    return results


def show_community(graph_data, community_num):
    """Show all nodes in a community."""
    nodes = graph_data['nodes']
    
    community_nodes = [n for n in nodes if n.get('community') == community_num]
    
    if not community_nodes:
        print(f"No community {community_num} found")
        return
    
    print(f"Community {community_num}: {len(community_nodes)} nodes\n")
    for n in community_nodes[:50]:
        label = n.get('label', n['id'])
        sf = n.get('source_file', 'unknown')
        print(f"  {label} ({sf})")
    
    if len(community_nodes) > 50:
        print(f"\n  ... and {len(community_nodes) - 50} more")


def find_related(graph_data, term):
    """Find nodes semantically related to a term."""
    nodes = graph_data['nodes']
    links = graph_data['links']
    
    matched = find_nodes_matching(graph_data, term, limit=10)
    if not matched:
        print(f"No nodes matching: {term}")
        return
    
    print(f"Nodes related to '{term}':\n")
    for n in matched:
        label = n.get('label', n['id'])
        sf = n.get('source_file', 'unknown')
        print(f"  {label} ({sf})")


def check_test_coverage(graph_data, func_name):
    """Check which test files cover a function."""
    nodes = graph_data['nodes']
    links = graph_data['links']
    
    func_lower = func_name.lower()
    
    # Find function node
    func_node = None
    for n in nodes:
        if func_lower in n.get('label', '').lower():
            func_node = n
            break
    
    if not func_node:
        print(f"Function not found: {func_name}")
        return
    
    # Find test nodes
    test_nodes = [n for n in nodes if 'test' in n.get('source_file', '').lower()]
    
    # Find edges from tests to function
    test_callers = []
    for t in test_nodes:
        for l in links:
            if l.get('source') == t['id'] and l.get('target') == func_node['id']:
                test_callers.append(t)
                break
    
    print(f"Test coverage for '{func_node.get('label', func_name)}':\n")
    if test_callers:
        for t in test_callers[:10]:
            print(f"  {t.get('source_file', 'unknown')}")
    else:
        print("  No direct test coverage found")
        # Also check imports
        for l in links:
            if l.get('target') == func_node['id'] and 'test' in l.get('source_file', '').lower():
                print(f"  (imports) {l.get('source_file', 'unknown')}")


def main():
    parser = argparse.ArgumentParser(
        description='Query the knowledge graph',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/graph-query.py --callers "handleToggleBackgroundTasks"
  python3 scripts/graph-query.py --path "app.ts" "session-sidebar.ts"
  python3 scripts/graph-query.py --edges-from "app.ts"
  python3 scripts/graph-query.py --community 0
  python3 scripts/graph-query.py --related-to "session"
  python3 scripts/graph-query.py --test-coverage "sweepCronRunSessions"
        """
    )
    
    parser.add_argument('--callers', metavar='FUNC',
                        help='Find all callers of a function')
    parser.add_argument('--path', nargs=2, metavar=('START', 'END'),
                        help='Find shortest path between two concepts')
    parser.add_argument('--edges-from', metavar='NODE',
                        help='Find all outgoing edges from a node')
    parser.add_argument('--edges-to', metavar='NODE',
                        help='Find all incoming edges to a node')
    parser.add_argument('--community', type=int, metavar='NUM',
                        help='Show all nodes in a community')
    parser.add_argument('--related-to', metavar='TERM',
                        help='Find nodes related to a term')
    parser.add_argument('--test-coverage', metavar='FUNC',
                        help='Check test coverage for a function')
    parser.add_argument('--graph', default='graphify-out/graph.json',
                        help='Path to graph.json')
    
    args = parser.parse_args()
    
    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(0)
    
    graph_data = load_graph()
    
    if args.callers:
        callers = find_callers(graph_data, args.callers)
        print(f"Callers of '{args.callers}':\n")
        for c in callers[:20]:
            print(f"  {c.get('label', c['id'])} ({c.get('source_file', 'unknown')})")
        if not callers:
            print("  No callers found")
    
    elif args.path:
        results = find_path(graph_data, args.path[0], args.path[1])
        if results:
            for start, end, path in results:
                print(f"Path from '{start.get('label', start['id'])}' to '{end.get('label', end['id'])}':\n")
                node_map = {n['id']: n for n in graph_data['nodes']}
                for i, nid in enumerate(path):
                    n = node_map.get(nid, {})
                    label = n.get('label', nid)
                    if i < len(path) - 1:
                        print(f"  {i+1}. {label}")
                    else:
                        print(f"  {i+1}. {label}")
        else:
            print("No path found")
    
    elif args.edges_from:
        results = find_edges_from(graph_data, args.edges_from, 'out')
        if results:
            print(f"Edges from '{args.edges_from}':\n")
            for source, l, target in results[:30]:
                rel = l.get('relation', '')
                conf = l.get('confidence', '')
                print(f"  {source.get('label', source['id'])} --{rel}--> {target.get('label', target.get('id', '?'))} [{conf}]")
    
    elif args.edges_to:
        results = find_edges_from(graph_data, args.edges_to, 'in')
        if results:
            print(f"Edges to '{args.edges_to}':\n")
            for source, l, target in results[:30]:
                rel = l.get('relation', '')
                conf = l.get('confidence', '')
                print(f"  {source.get('label', source.get('id', '?'))} --{rel}--> {target.get('label', target['id'])} [{conf}]")
    
    elif args.community is not None:
        show_community(graph_data, args.community)
    
    elif args.related_to:
        find_related(graph_data, args.related_to)
    
    elif args.test_coverage:
        check_test_coverage(graph_data, args.test_coverage)
    
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
