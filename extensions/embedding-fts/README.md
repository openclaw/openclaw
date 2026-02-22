# embedding-fts Plugin

> **Unified embedding system with FTS5 fallback, dim-mismatch protection, and 429 retry-with-backoff.**

This plugin provides reusable embedding infrastructure for memory and search subsystems.

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

## 启用插件

此插件默认**不启用**。需要在 agent 配置的插件部分显式设置 `enabled: true` 才能激活：

```jsonc
// 在 agent 配置中启用本插件
{
  "plugins": {
    "embedding-fts": {
      "enabled": true,
      "provider": "auto"
    }
  }
}
```

## Configuration

| Key                 | Type     | Default | Description                                        |
| ------------------- | -------- | ------- | -------------------------------------------------- |
| `enabled`           | boolean  | false   | 是否启用插件（必须设为 true 才生效）               |
| `provider`          | string   | "auto"  | Embedding provider (cascading fallback)             |
| `fallback`          | string   | "none"  | Fallback provider when primary fails                |
| `model`             | string   | ""      | Embedding model id                                  |
| `fts5ExtensionPath` | string   | ""      | Custom path to FTS5 loadable extension              |
| `retryBaseDelayMs`  | number   | 2000    | Base delay for 429 retry backoff                    |
| `retryMaxAttempts`  | number   | 3       | Max retry attempts on rate-limit                    |
