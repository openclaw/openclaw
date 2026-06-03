---
summary: "How to enable and configure the external reranker plugin for Cohere-compatible reranking endpoints"
title: "External reranker plugin"
sidebarTitle: "External reranker"
read_when:
  - You want to use an external reranking service (Cohere, Jina, Voyage AI, etc.)
  - You want to proxy reranking through a local server (llama.cpp, vLLM, etc.)
  - You need to configure custom reranking endpoints
---

The external reranker plugin lets you proxy reranking requests to any Cohere-compatible `/v1/rerank` endpoint. This includes:

- **Cloud services**: Cohere, Jina, Voyage AI, and other providers with Cohere-compatible APIs
- **Local servers**: llama.cpp with `--reranking`, vLLM, Ollama (with reranking support)
- **Self-hosted**: Any custom reranking service that implements the Cohere API

<CardGroup cols={2}>
  <Card title="Memory rerankers" href="/concepts/memory-rerankers">
    Conceptual overview of reranking in OpenClaw memory search.
  </Card>
  <Card title="Memory configuration" href="/reference/memory-config">
    Full memory search configuration reference.
  </Card>
</CardGroup>

---

## Enabling the external reranker

The external reranker plugin is **not enabled by default**. To enable it, add the plugin to your `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          // Your reranker configuration here
        },
      },
    },
  },
}
```

---

## Configuration fields

The external reranker accepts the following configuration options:

<ParamField path="plugins.entries.memory-external-reranker.config.model" type="string">
  The reranker model ID to use. This is provider-specific:

- Cohere: `rerank-english-v3.0`, `rerank-multilingual-v3.0`, `rerank-english-v2.0`
- Jina: `jina-reranker-v2-base-multilingual`
- Voyage AI: `rerank-2`, `rerank-lite-2`
- llama.cpp: `llama.cpp` (any model loaded with `--reranking`)

The model ID is sent in the `model` field of the rerank request.
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.modelFallbacks" type="string[]">
  Array of alternate model IDs to try if the primary model fails. The plugin will attempt each fallback in order until one succeeds or all options are exhausted.

Example: `["rerank-english-v2.0", "rerank-multilingual-v2.0"]`
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.endpointPath" type="string">
  HTTP path for the rerank endpoint. Default: `/v1/rerank`

Change this if your provider uses a different path (e.g., `/rerank`, `/api/v1/rerank`).
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.topN" type="number">
  Maximum number of results to return. Must be a positive integer (minimum: 1).

If not specified, the provider's default is used. Set this to limit the response size and improve performance.
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.providers" type="object">
  Map of provider IDs to endpoint configuration. Each provider entry defines a Cohere-compatible endpoint:

```json5
{
  providerId: {
    baseUrl: "https://api.provider.com",
    apiKey: "your-api-key",
  },
}
```

- `baseUrl`: The base URL of the reranking endpoint (required)
- `apiKey`: API key for authentication (optional, depends on provider)
  </ParamField>

---

## Provider configuration

### Cohere

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "rerank-english-v3.0",
          providers: {
            cohere: {
              baseUrl: "https://api.cohere.ai/v1",
              apiKey: "${COHERE_API_KEY}",
            },
          },
        },
      },
    },
  },
}
```

### Jina AI

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "jina-reranker-v2-base-multilingual",
          endpointPath: "/v1/rerank",
          providers: {
            jina: {
              baseUrl: "https://api.jina.ai",
              apiKey: "${JINA_API_KEY}",
            },
          },
        },
      },
    },
  },
}
```

### Voyage AI

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "rerank-2",
          providers: {
            voyage: {
              baseUrl: "https://api.voyageai.com/v1",
              apiKey: "${VOYAGE_API_KEY}",
            },
          },
        },
      },
    },
  },
}
```

### llama.cpp (local)

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "llama.cpp",
          providers: {
            llama: {
              baseUrl: "http://localhost:8080",
              // No API key needed for local llama.cpp
            },
          },
        },
      },
    },
  },
}
```

### vLLM (local)

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "vllm",
          providers: {
            vllm: {
              baseUrl: "http://localhost:8000",
              // No API key needed for local vLLM
            },
          },
        },
      },
    },
  },
}
```

---

## Integration with memory search

After enabling the external reranker plugin, configure memory search to use it:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            mmr: {
              enabled: true,
              lambda: 0.7,
              provider: "memory-external-reranker", // Use external reranker
              fallback: "none", // No fallback
            },
          },
        },
      },
    },
  },
}
```

### Full example with external reranker

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          model: "rerank-english-v3.0",
          modelFallbacks: ["rerank-english-v2.0"],
          topN: 20,
          providers: {
            cohere: {
              baseUrl: "https://api.cohere.ai/v1",
              apiKey: "${COHERE_API_KEY}",
            },
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
        query: {
          hybrid: {
            enabled: true,
            vectorWeight: 0.7,
            textWeight: 0.3,
            mmr: {
              enabled: true,
              lambda: 0.7,
              provider: "memory-external-reranker",
              fallback: "none",
            },
          },
        },
      },
    },
  },
}
```

---

## Fallback behavior

The external reranker supports two levels of fallback to ensure reranking reliability:

### Model fallbacks (within the same provider)

The external reranker plugin handles its own model fallbacks by trying alternate models on the same endpoint. Configure this with the `modelFallbacks` array:

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        config: {
          model: "rerank-english-v3.0",
          modelFallbacks: ["rerank-english-v2.0", "rerank-english-v1.0"],
          providers: {
            cohere: {
              baseUrl: "https://api.cohere.ai/v1",
              apiKey: "${COHERE_API_KEY}",
            },
          },
        },
      },
    },
  },
}
```

The plugin will try each model in order until one succeeds. This is useful when a newer model is temporarily unavailable.

### Provider fallback (different reranker plugin)

The memory search system has a separate `fallback` configuration that points to a different reranker plugin. By default, fallback is set to `"none"`:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            mmr: {
              enabled: true,
              lambda: 0.7,
              provider: "memory-external-reranker",
              fallback: "none", // Default: no fallback
            },
          },
        },
      },
    },
  },
}
```

To use the internal MMR reranker as a backup when the external reranker fails, explicitly set `fallback: "memory-mmr"`:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            mmr: {
              enabled: true,
              lambda: 0.7,
              provider: "memory-external-reranker",
              fallback: "memory-mmr", // Use internal MMR as fallback
            },
          },
        },
      },
    },
  },
}
```

### What happens when reranking fails

- **Primary reranker fails, no fallback configured**: Results are returned without reranking (sorted by original scores)
- **Primary reranker fails, fallback configured**: System tries the fallback reranker
- **Both primary and fallback fail**: Results are returned without reranking

This ensures that memory search always returns results, even if reranking is unavailable.

---

## Environment variables

Use environment variable substitution (`${VAR_NAME}`) for sensitive values like API keys:

```bash
export COHERE_API_KEY="your-cohere-api-key"
export JINA_API_KEY="your-jina-api-key"
export VOYAGE_API_KEY="your-voyage-api-key"
```

Then reference them in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "memory-external-reranker": {
        config: {
          providers: {
            cohere: {
              apiKey: "${COHERE_API_KEY}",
            },
          },
        },
      },
    },
  },
}
```

---

## Troubleshooting

### Connection errors

If you see connection errors to the reranking endpoint:

1. Verify the `baseUrl` is correct and accessible
2. Check that the endpoint supports the `/v1/rerank` path
3. Ensure any required API keys are set correctly
4. Test the endpoint directly with `curl`:

   ```bash
   curl -X POST https://api.cohere.ai/v1/rerank \
     -H "Authorization: Bearer ${COHERE_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "rerank-english-v3.0",
       "query": "test query",
       "documents": ["test document"]
     }'
   ```

### Model not found

If the provider returns a "model not found" error:

1. Verify the `model` field matches the provider's model ID
2. Check the provider's documentation for available reranker models
3. Try a different model from the `modelFallbacks` list

### Performance issues

To improve reranking performance:

1. Set `topN` to limit the number of results returned
2. Use a smaller model if available (e.g., `rerank-lite-2` instead of `rerank-2`)
3. Consider using a local reranker (llama.cpp, vLLM) for faster response times
