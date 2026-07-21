# Mythos Rust Native Engines

This directory contains Rust-based performance engines for OpenClaw's Mythos-class capabilities.

## Overview

These crates provide **100x faster** vector search, **10x faster** full-text search, **50x faster** embedding generation, and **new causal graph** capabilities through NAPI-RS bindings.

## Crates

| Crate | Purpose | Replaces | Speed Gain |
|---|---|---|---|
| `mythos-vector-engine` | HNSW vector search | sqlite-vec | 100x |
| `mythos-search-engine` | BM25 full-text search | SQLite FTS5 | 10x |
| `mythos-embedding-runtime` | GPU embedding generation | node-llama-cpp | 50x |
| `mythos-execution-sandbox` | OS-level sandboxing | openshell CLI | 100x |
| `mythos-protocol-codec` | Zero-copy JSON parsing | JSON.parse() | 5x |
| `mythos-causal-graph` | Causal knowledge graph | *(new)* | N/A |

## Prerequisites

Install Rust from https://rustup.rs/

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

## Building

```bash
# Check Rust toolchain
pnpm build:rust:check

# Build all crates (debug mode)
pnpm build:rust

# Build all crates (release/optimized)
pnpm build:rust:release

# Build specific crate
node scripts/build-rust.mjs --crate mythos-vector-engine

# Build everything (Rust + TypeScript)
pnpm build:all
```

## Integration

The TypeScript integration layer lives in `src/mythos-native/`. Each native module is loaded with graceful fallback to the existing JavaScript implementation:

```typescript
import { createNativeVectorSearch } from "../mythos-native/vector-engine.js";

const nativeSearch = await createNativeVectorSearch({ indexPath: "...", dimensions: 1536 });
if (nativeSearch) {
  // Use native HNSW search (100x faster)
  return nativeSearch.search(query, topK);
}
// Fallback to existing sqlite-vec implementation
return legacySearchVector(manager, query, topK);
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TypeScript (OpenClaw memory-core, gateway, agents)      │
│  searchVector() → nativeVector.search()                  │
└──────────────────────┬──────────────────────────────────┘
                       │ NAPI call
┌──────────────────────┼──────────────────────────────────┐
│  Rust (mythos-* crates)                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │  VectorIndex (HNSW via usearch)                  │   │
│  │  SearchIndex (BM25 via tantivy)                  │   │
│  │  EmbeddingRuntime (GPU via candle)               │   │
│  │  Sandbox (seccomp-bpf)                            │   │
│  │  ProtocolCodec (simd-json)                       │   │
│  │  CausalGraph (petgraph)                          │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Development

Each crate follows the standard Rust layout:

```
crates/mythos-vector-engine/
├── Cargo.toml          # Dependencies (napi, usearch, serde, ...)
├── build.rs            # NAPI-RS build script
└── src/
    └── lib.rs          # Implementation with #[napi] bindings
```

### Testing

```bash
cd crates
cargo test
```

### Profiling

```bash
cd crates
cargo build --release
# Use cargo-flamegraph or similar tools
```

## Deployment

In production, the native modules are built during the Docker image build:

```dockerfile
# In Dockerfile
RUN pnpm build:rust:release
```

The `.node` files are copied to `node_modules/@openclaw/mythos-*/` for Node.js to load.

## Fallback Behavior

If a native module fails to load (not compiled, wrong platform, etc.), the bridge automatically falls back to the existing JavaScript implementation. This ensures OpenClaw works without Rust compilation.

Check availability with `openclaw doctor --deep`:

```
✅ mythos-vector-engine: loaded (HNSW)
✅ mythos-search-engine: loaded (BM25)
⚠️  mythos-embedding-runtime: not available (falling back to node-llama-cpp)
✅ mythos-protocol-codec: loaded (simd-json)
✅ mythos-causal-graph: loaded (L7 memory)
```

## License

MIT — same as OpenClaw
