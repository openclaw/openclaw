# Model Selection Guide

## Benchmark Results (LongMemEval — ICLR 2025, 500 questions)

| Model | Size | GPU? | R@5 | R@10 | NDCG@10 | Best For |
|-------|------|------|-----|------|---------|----------|
| `all-MiniLM-L6-v2` (default) | 90MB | No | 93.4% | 97.4% | 90.8% | Laptops, CI/CD, prototyping |
| `BAAI/bge-large-en-v1.5` | 1.3GB | Recommended | 95.9% | 98.2% | 94.0% | Production servers |
| `intfloat/e5-large-v2` | 1.3GB | Recommended | 96.0% | 98.1% | 94.6% | Best ranking quality |
| `thenlper/gte-large` | 1.3GB | Recommended | 96.6% | 98.7% | 94.3% | Maximum retrieval accuracy |

## Usage

```python
from quantum_memory_graph import MemoryGraph

# Default — works everywhere
mg = MemoryGraph()

# High accuracy
mg = MemoryGraph(model="thenlper/gte-large")

# Best ranking
mg = MemoryGraph(model="intfloat/e5-large-v2")
```

## Notes

- Default runs on CPU, any machine. No GPU needed.
- Larger models benefit from GPU (60x speedup) but work on CPU too — just slower.
- All models produce normalized embeddings for cosine similarity.
- Pass any sentence-transformers model name to `model=` parameter.
