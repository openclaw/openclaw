# embedding-fts Plugin

> **Unified embedding system with FTS5 fallback, dim-mismatch protection, and 429 retry-with-backoff.**

This plugin provides reusable embedding infrastructure for memory and search subsystems.

## Enabling the Plugin

This plugin is **not loaded by default**. Add it to the `plugins.entries` section of your openclaw config with `enabled: true`:

```jsonc
{
  "plugins": {
    "entries": {
      "embedding-fts": {
        "enabled": true,
        "config": {
          "provider": "auto"
        }
      }
    }
  }
}
```

## Features

| Feature                     | Description                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| **Noop/BM25 fallback**      | Graceful degradation to keyword-only search when no embedding provider is available            |
| **Hash embedding**          | Deterministic, low-cost embedding fallback for development and testing                        |
| **Transformer provider**    | Local ONNX inference via `@xenova/transformers` (384-dim MiniLM by default)                   |
| **429 retry-with-backoff**  | Automatic retry with exponential backoff on rate-limit errors                                 |
| **Dim-mismatch detection**  | Detects when stored vectors have different dimensions from current provider                   |
| **FTS5 extension loader**   | Auto-detects and loads SQLite FTS5 extension from multiple candidate paths                     |
| **FTS5 schema helper**      | Combines extension loading + DDL in a single call                                             |

## Usage

```ts
import {
  createNoopEmbeddingProvider,
  createHashEmbeddingProvider,
  createTransformerEmbeddingProvider,
  withRetryBackoff,
  probeEmbeddingAvailability,
  isDimMismatch,
  loadFts5Extension,
  ensureFts5Schema,
} from "@openclaw/embedding-fts";
```

## Configuration

| Key                 | Type     | Default | Description                                        |
| ------------------- | -------- | ------- | -------------------------------------------------- |
| `provider`          | string   | "auto"  | Embedding provider (cascading fallback)             |
| `fallback`          | string   | "none"  | Fallback provider when primary fails                |
| `model`             | string   | ""      | Embedding model id                                  |
| `fts5ExtensionPath` | string   | ""      | Custom path to FTS5 loadable extension              |
| `retryBaseDelayMs`  | number   | 2000    | Base delay for 429 retry backoff                    |
| `retryMaxAttempts`  | number   | 3       | Max retry attempts on rate-limit                    |
