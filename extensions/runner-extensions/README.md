# runner-extensions Plugin

> **Dynamic pi-extension loading infrastructure for the embedded agent runner.**

This plugin packages the extension path resolution, memory-context wiring, 
embedding upgrade probe logic, and `memoryContext` agent config schema 
into a reusable extension.

## Features

| Feature                        | Description                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| **Dynamic path resolution**    | Resolves `.ts`/`.js` extension paths with jiti fallback for dev/production compat              |
| **Memory-context wiring**      | Builds extension path lists for memory-context-recall and memory-context-archive               |
| **Embedding upgrade probes**   | Periodically re-probes fallback embeddings to swap in better providers when they recover       |
| **Config schema**              | `MemoryContextAgentConfig` type for `agents.defaults.memoryContext` settings                   |
| **Compaction safeguard**       | Conditionally loads compaction-safeguard extension based on config mode                        |

## Usage

```ts
import {
  resolveExtensionPath,
  buildExtensionPaths,
  shouldProbeEmbeddingUpgrade,
  type MemoryContextAgentConfig,
  type MemoryContextCacheEntry,
} from "@openclaw/runner-extensions";
```
