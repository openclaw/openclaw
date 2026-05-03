---
name: quantum-memory
description: "Quantum-optimized knowledge graph memory. #1 on LongMemEval (ICLR 2025): R@5 95.8%, R@10 98.85%"
author: "@Coinkong"
version: 1.1.1
---

# Quantum Memory Graph

Knowledge-graph-based memory for AI agents using QAOA (Quantum Approximate Optimization Algorithm) for optimal subgraph selection.

## Install

```bash
pip install quantum-memory-graph
```

## Quick Start

```python
from quantum_memory_graph import store, recall

# Store memories — automatically builds knowledge graph
store("Project Alpha uses React frontend with TypeScript.")
store("Project Alpha backend is FastAPI with PostgreSQL.")

# Recall — graph traversal + QAOA finds the optimal combination
result = recall("What is Project Alpha's tech stack?", K=4)
```

## Why QMG?

Traditional memory systems treat memories as independent documents. QMG maps **relationships** between memories, then uses QAOA to find the optimal *combination* — not just relevant individuals, but the best connected subgraph.

## Benchmark Results

Tested on [LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025):

| Method | R@5 | R@10 | NDCG@10 |
|--------|-----|------|---------|
| OMEGA (prev SOTA) | 89.2% | 94.1% | 87.5% |
| Mastra OM | 91.0% | 95.2% | 89.1% |
| **QMG** | **95.8%** | **98.85%** | **93.2%** |

Full benchmark: 250 scenarios, 320 weight combinations, 12 hours on DGX Spark GB10.

## Links

- PyPI: https://pypi.org/project/quantum-memory-graph/
- GitHub: https://github.com/Dustin-a11y/quantum-memory-graph
- Author: @Coinkong (Chef's Attraction)
