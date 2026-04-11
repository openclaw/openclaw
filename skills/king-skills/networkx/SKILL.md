---
name: king_skill_networkx
description: Graph analysis, network topology, path finding, centrality, community detection using NetworkX. Critical for P2P network analysis.
metadata:
  openclaw:
    emoji: 🕸️
    requires:
      bins: ["python3", "pip"]
    install:
      - type: pip
        packages: ["networkx", "matplotlib", "scipy", "numpy"]
    os: ["darwin", "linux", "win32"]
---

# NetworkX Graph Analysis

Graph analysis, network topology, path finding, centrality, community detection.

## When to Use

**USE this skill when:**
- Analyzing graph/network topology
- Finding shortest paths
- Computing centrality metrics
- Community detection
- P2P network analysis
- DAG operations
- Connectivity checking

**DON'T use when:**
- Problem is not graph-based
- Simple tree structures suffice

## Commands

```python
import networkx as nx
import numpy as np

# Build P2P network
G = nx.Graph()
G.add_nodes_from(range(N_nodes))
G.add_edges_from(edges)

# Topology metrics
metrics = {
    "n_nodes": G.number_of_nodes(),
    "n_edges": G.number_of_edges(),
    "avg_degree": np.mean([d for _, d in G.degree()]),
    "diameter": nx.diameter(G),
    "clustering": nx.average_clustering(G),
    "connected": nx.is_connected(G),
    "betweenness": nx.betweenness_centrality(G),
    "pagerank": nx.pagerank(G),
}
```

### Byzantine Fault Tolerance Check

```python
def bft_check(G, f):
    """Check if graph survives f Byzantine node failures."""
    import itertools
    for removed in itertools.combinations(G.nodes(), f):
        H = G.copy()
        H.remove_nodes_from(removed)
        if not nx.is_connected(H):
            return False
    return True
```

### DAG Operations

```python
DAG = nx.DiGraph()
DAG.add_edges_from(dependencies)
order = list(nx.topological_sort(DAG))
```

### P2P Consensus Simulation

```python
def simulate_consensus(G, initial_states, T=100):
    states = dict(zip(G.nodes(), initial_states))
    for _ in range(T):
        new_states = {}
        for node in G.nodes():
            nbr_states = [states[n] for n in G.neighbors(node)]
            new_states[node] = np.mean(nbr_states + [states[node]])
        states = new_states
    return states
```

## Notes

- Critical for P2P network analysis in OpenClaw
- Token savings: 5/5
- Status: ✅ Verified
