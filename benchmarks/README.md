# Mythos Performance Benchmarks

Comprehensive benchmark suite comparing Rust-native engines against JavaScript baselines.

## Overview

These benchmarks validate the performance claims made for Mythos-class implementation:
- Vector search: 100x faster than sqlite-vec
- Text search: 10x faster than FTS5
- Embedding generation: 50x faster than node-llama-cpp
- Protocol parsing: 5x faster than JSON.parse
- Sandbox execution: 100x less overhead

## Running Benchmarks

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node.js 22+
nvm install 22

# Install dependencies
pnpm install

# Build Rust engines
pnpm build:rust:release
```

### Run All Benchmarks

```bash
# Run complete benchmark suite
node benchmarks/run-all.js

# Generate HTML report
node benchmarks/run-all.js --html

# Compare against baseline
node benchmarks/run-all.js --compare baseline.json
```

### Run Specific Benchmarks

```bash
# Vector search benchmark
node benchmarks/vector-search-benchmark.js

# Text search benchmark
node benchmarks/text-search-benchmark.js

# Embedding generation
node benchmarks/embedding-benchmark.js

# Protocol codec
node benchmarks/protocol-benchmark.js

# A2A protocol
node benchmarks/a2a-benchmark.js
```

## Benchmark Results

### Expected Performance

| Operation | JavaScript | Rust Native | Improvement |
|-----------|------------|-------------|-------------|
| Vector search (1M) | 10,000ms | 100ms | **100x** |
| Text search (1M docs) | 5,000ms | 500ms | **10x** |
| Embedding (single) | 52ms | 1ms | **52x** |
| Embedding (batch 100) | 4,800ms | 100ms | **48x** |
| Protocol parse | 1.0μs | 0.2μs | **5x** |
| Sandbox create | 105ms | 1ms | **105x** |

### Benchmark Environment

- **CPU**: Apple M4 Pro (14-core)
- **RAM**: 48GB
- **OS**: macOS 15.2
- **Node.js**: 22.16.0
- **Rust**: 1.75.0

## Benchmark Scripts

### vector-search-benchmark.js

Tests HNSW vector search performance:
- Index creation time
- Query latency (p50, p90, p95, p99)
- Throughput (queries/second)
- Memory usage
- Comparison with sqlite-vec

### text-search-benchmark.js

Tests Tantivy BM25 search performance:
- Index creation time
- Query latency for different query types
- Throughput under load
- Disk usage
- Comparison with FTS5

### embedding-benchmark.js

Tests GPU-accelerated embedding generation:
- Single embedding latency
- Batch processing throughput
- Memory usage
- CPU vs GPU vs JavaScript comparison

### protocol-benchmark.js

Tests zero-copy JSON parsing:
- Parse latency for different payload sizes
- Throughput (frames/second)
- Memory allocations
- Comparison with JSON.parse

### a2a-benchmark.js

Tests Agent-to-Agent protocol:
- Message routing latency
- Pub/sub throughput
- Task coordination overhead
- Blackboard operations

## Interpreting Results

### Latency Metrics

- **p50**: Median latency (typical case)
- **p90**: 90th percentile (90% of requests faster)
- **p95**: 95th percentile (SLA target)
- **p99**: 99th percentile (worst case)

### Throughput Metrics

- **ops/sec**: Operations per second
- **MB/s**: Throughput in megabytes per second
- **QPS**: Queries per second

### Memory Metrics

- **RSS**: Resident Set Size (actual memory used)
- **Heap**: JavaScript heap size
- **Native**: Rust native memory

## Continuous Benchmarking

### GitHub Actions

Benchmarks run automatically on:
- Every PR to main branch
- Weekly scheduled runs
- Release tags

View results: https://github.com/openclaw/openclaw/actions

### Local CI

```bash
# Run benchmark in CI mode
node benchmarks/run-all.js --ci

# Check against thresholds
node benchmarks/run-all.js --threshold benchmarks/thresholds.json
```

## Thresholds

Benchmark thresholds ensure performance doesn't regress:

```json
{
  "vector_search": {
    "p95_latency_ms": 500,
    "throughput_qps": 1000,
    "memory_mb": 4000
  },
  "text_search": {
    "p95_latency_ms": 200,
    "throughput_qps": 5000,
    "memory_mb": 2000
  },
  "embedding": {
    "single_latency_ms": 10,
    "batch_throughput": 1000
  }
}
```

## Performance Tuning

### HNSW Parameters

Tune vector search performance:

```rust
let index = VectorIndex::new(
    1536,              // dimensions
    "cosine",          // metric
    100000,            // max_elements
    Some(200),         // ef_construction (quality)
    Some(16),          // m (connectivity)
);
```

**Recommendations:**
- Higher `ef_construction`: Better recall, slower indexing
- Higher `m`: Better connectivity, more memory

### Tantivy Parameters

Tune text search performance:

```rust
let index = SearchIndex::new(
    "/path/to/index",
    Some("default"),   // tokenizer
    Some(50_000_000),  // writer_buffer (50MB)
    Some(true),        // sort_by_doc
);
```

**Recommendations:**
- Larger buffer: Faster indexing, more memory
- Custom tokenizer: Better for specific languages

### Resource Allocation

For Kubernetes:

```yaml
resources:
  requests:
    cpu: 2000m
    memory: 4Gi
  limits:
    cpu: 4000m
    memory: 8Gi
```

## Troubleshooting

### Benchmark Fails to Run

```bash
# Check Rust build
cargo build --release

# Check Node.js version
node --version  # Should be 22+

# Rebuild everything
pnpm install
pnpm build:rust:release
pnpm build
```

### Slow Performance

1. **Check native engines are loaded**:
   ```bash
   node scripts/mythos/operator-runbook.js engines
   ```

2. **Verify GPU acceleration**:
   ```bash
   node benchmarks/embedding-benchmark.js --verbose
   ```

3. **Check resource limits**:
   ```bash
   kubectl top pods -l app=mythos
   ```

### Memory Issues

1. **Reduce index size**:
   ```javascript
   const index = new VectorIndex(1536, "cosine", 10000); // Smaller max_elements
   ```

2. **Enable garbage collection**:
   ```bash
   node --expose-gc benchmarks/run-all.js
   ```

3. **Monitor memory**:
   ```bash
   node --inspect benchmarks/run-all.js
   ```

## Documentation

- **[Architecture](../MYTHOS-CLASS-ARCHITECTURE-SPEC.md)**: System design
- **[Implementation](../MYTHOS-CLASS-PART-IV.md)**: Build guide
- **[Monitoring](../monitoring/README.md)**: Production monitoring
- **[Load Testing](../load-testing/README.md)**: Load testing suite

## Support

- **Issues**: [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- **Discord**: [OpenClaw Discord](https://discord.gg/openclaw)

## License

MIT License - See [LICENSE](../LICENSE) for details.
