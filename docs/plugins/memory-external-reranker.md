---
summary: "How to enable and configure the external reranker plugin for Cohere-compatible reranking endpoints"
title: "External reranker plugin"
sidebarTitle: "External reranker"
read_when:
  - You want to use an external reranking service (Cohere, Jina, Voyage AI, etc.)
  - You want to proxy reranking through a local server (llama.cpp, vLLM, etc.)
  - You need to configure custom reranking endpoints
---

The external reranker plugin lets you replace mmr in memorySearch:hybrid and proxy reranking requests to any Cohere-compatible `/v1/rerank` endpoint. This includes:

- **Cloud services**: Cohere, Jina, Voyage AI, and other providers with Cohere-compatible APIs
- **Local servers**: llama.cpp with `--reranking`, vLLM, Ollama (with reranking support)
- **Self-hosted**: Any custom reranking service that implements the Cohere API

Install route: npm; ClawHub (`@openclaw/memory-external-reranker`).

<Warning>
  This plugin sends the user query and candidate memory snippets to the configured provider
  endpoint, and may attach the provider API key from `models.providers.<id>.apiKey`. Treat the
  endpoint as operator-approved egress: review redaction, logging, retention, SSRF/private-network
  policy, and credential handling before enabling it. Private-network opt-in is controlled on the
  model provider via `models.providers.<id>.request.allowPrivateNetwork`.
</Warning>

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

## How provider and credential configuration works

The plugin uses two separate config fields:

- **`provider`** — the provider ID, looked up in `models.providers` in your OpenClaw config. This is where the endpoint `baseUrl` and API key live.
- **`model`** — the model ID sent in the rerank request body.

```json5
{
  config: {
    provider: "cohere", // key in models.providers
    model: "rerank-english-v3.0", // sent as model in the request
  },
}
```

This keeps all endpoint URLs and credentials in one place (`models.providers`) rather than inside the plugin config. API keys use OpenClaw's standard secret facilities and are never stored as plain strings in `openclaw.json`. See [API key configuration](#api-key-configuration) below.

---

## Configuration fields

<ParamField path="plugins.entries.memory-external-reranker.config.provider" type="string" required>
  Provider ID — must match a key in `models.providers` in your OpenClaw config. All model candidates (primary and fallbacks) are served by this provider.
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.model" type="string" required>
  The model ID to send in the rerank request body. Provider-specific examples:

- Cohere: `rerank-english-v3.0`, `rerank-multilingual-v3.0`
- Jina: `jina-reranker-v2-base-multilingual`
- Voyage AI: `rerank-2`, `rerank-lite-2`
- llama.cpp: the model name loaded with `--embedding  --reranking  --pooling rank \`

</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.modelFallbacks" type="string[]">
  Ordered list of alternate model IDs (on the same provider) to try if the primary model fails.

Example: `["rerank-english-v2.0", "rerank-multilingual-v2.0"]`
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.endpointPath" type="string">
  HTTP path for the rerank endpoint. Default: `/v1/rerank`

Change this if your provider uses a different path (e.g., `/rerank`, `/api/v1/rerank`).

The runtime builds the final URL as `models.providers.<provider>.baseUrl + endpointPath`.
If your provider `baseUrl` already ends in `/v1`, set `endpointPath: "/rerank"` (or remove
`/v1` from `baseUrl`) so requests do not end up at `/v1/v1/rerank`.
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.topN" type="number">
  Maximum number of results to return. Must be a positive integer (minimum: 1).

If not specified, the value from `limit` in the active memory search request is used. Set this to cap results independently of the search limit.
</ParamField>

<ParamField path="plugins.entries.memory-external-reranker.config.additionalBodyParams" type="object">
  Extra fields merged verbatim into the rerank request body. Use this for provider-specific parameters that are not covered by the named fields above. Unknown fields are ignored by providers that do not support them.

Common examples:

- `max_chunks_per_doc` (Cohere) — controls how long documents are split into chunks before scoring
- `truncation` (Voyage AI) — `"NONE"` or `"END"`, controls what happens when inputs exceed the context window

```json5
{
  config: {
    provider: "cohere",
    model: "rerank-english-v3.0",
    additionalBodyParams: {
      max_chunks_per_doc: 10,
    },
  },
}
```

</ParamField>

---

## Provider configuration

Endpoint URLs go in `models.providers` in your `openclaw.json`. The key you choose is what you set as `provider` in the plugin config.

<Note>
  Custom providers must include a `models` array declaring every model they expose. OpenClaw will reject the config with a validation error if `models` is missing or empty.
</Note>

### Cohere

```json5
{
  models: {
    providers: {
      cohere: {
        baseUrl: "https://api.cohere.ai",
        apiKey: { source: "env", provider: "default", id: "COHERE_API_KEY" },
        models: [
          { id: "rerank-english-v3.0", name: "Cohere Rerank English v3.0", input: ["text"] },
          {
            id: "rerank-multilingual-v3.0",
            name: "Cohere Rerank Multilingual v3.0",
            input: ["text"],
          },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "cohere",
          model: "rerank-english-v3.0",
        },
      },
    },
  },
}
```

### Jina AI

```json5
{
  models: {
    providers: {
      jina: {
        baseUrl: "https://api.jina.ai",
        apiKey: { source: "env", provider: "default", id: "JINA_API_KEY" },
        models: [
          {
            id: "jina-reranker-v2-base-multilingual",
            name: "Jina Reranker v2 Multilingual",
            input: ["text"],
          },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "jina",
          model: "jina-reranker-v2-base-multilingual",
        },
      },
    },
  },
}
```

### Voyage AI

```json5
{
  models: {
    providers: {
      voyage: {
        baseUrl: "https://api.voyageai.com",
        apiKey: { source: "env", provider: "default", id: "VOYAGE_API_KEY" },
        models: [
          { id: "rerank-2", name: "Voyage Rerank 2", input: ["text"] },
          { id: "rerank-lite-2", name: "Voyage Rerank Lite 2", input: ["text"] },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "voyage",
          model: "rerank-2",
        },
      },
    },
  },
}
```

### llama.cpp (local)

```json5
{
  models: {
    providers: {
      "llamacpp-local": {
        baseUrl: "http://localhost:8080",
        request: {
          allowPrivateNetwork: true,
        },
        // No API key needed for a local server
        models: [{ id: "my-reranker-model", name: "My Reranker Model", input: ["text"] }],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "llamacpp-local",
          model: "my-reranker-model",
        },
      },
    },
  },
}
```

### vLLM (local)

```json5
{
  models: {
    providers: {
      "vllm-local": {
        baseUrl: "http://localhost:8000",
        request: {
          allowPrivateNetwork: true,
        },
        // No API key needed for a local server
        models: [{ id: "my-reranker-model", name: "My Reranker Model", input: ["text"] }],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "vllm-local",
          model: "my-reranker-model",
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
            rerank: {
              enabled: true,
              stages: [
                // Single external reranker stage.
                { provider: "memory-external-reranker", lambda: 0.7 },
              ],
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
  models: {
    providers: {
      cohere: {
        baseUrl: "https://api.cohere.ai",
        apiKey: { source: "env", provider: "default", id: "COHERE_API_KEY" },
        models: [
          { id: "rerank-english-v3.0", name: "Cohere Rerank English v3.0", input: ["text"] },
          { id: "rerank-english-v2.0", name: "Cohere Rerank English v2.0", input: ["text"] },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        enabled: true,
        config: {
          provider: "cohere",
          model: "rerank-english-v3.0",
          modelFallbacks: ["rerank-english-v2.0"],
          topN: 20,
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
            rerank: {
              enabled: true,
              stages: [{ provider: "memory-external-reranker", lambda: 0.7 }],
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
  models: {
    providers: {
      cohere: {
        baseUrl: "https://api.cohere.ai",
        apiKey: { source: "env", provider: "default", id: "COHERE_API_KEY" },
        models: [
          { id: "rerank-english-v3.0", name: "Cohere Rerank English v3.0", input: ["text"] },
          { id: "rerank-english-v2.0", name: "Cohere Rerank English v2.0", input: ["text"] },
          { id: "rerank-english-v1.0", name: "Cohere Rerank English v1.0", input: ["text"] },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "memory-external-reranker": {
        config: {
          provider: "cohere",
          model: "rerank-english-v3.0",
          modelFallbacks: ["rerank-english-v2.0", "rerank-english-v1.0"],
        },
      },
    },
  },
}
```

The plugin will try each model in order until one succeeds. This is useful when a newer model is temporarily unavailable.

### Provider fallback (a later reranker stage)

Memory search reranking is a serial pipeline of stages. There is no dedicated
fallback slot; instead, add a second stage and the pipeline keeps the previous
stage's ordering whenever an earlier stage fails. To fall back to the internal
MMR reranker when the external reranker fails, add `memory-mmr` as a later
stage. Use `topK` on the external stage if you want it to narrow candidates
before MMR runs:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            rerank: {
              enabled: true,
              stages: [
                { provider: "memory-external-reranker", lambda: 0.7 },
                { provider: "memory-mmr", lambda: 0.5 },
              ],
            },
          },
        },
      },
    },
  },
}
```

### What happens when reranking fails

- **A stage fails or returns nothing**: the pipeline keeps the previous stage's ordering and continues with the remaining stages.
- **A stage's plugin is not installed**: that stage is skipped.
- **Every stage is skipped or fails**: results are returned without reranking (sorted by original scores).

This ensures that memory search always returns results, even if reranking is unavailable.

---

## API key configuration

API keys are stored in `models.providers.<id>.apiKey` using OpenClaw's `SecretInput` format. They are never written as plain strings in `openclaw.json`.

### Environment variable

```json5
{
  models: {
    providers: {
      cohere: {
        baseUrl: "https://api.cohere.ai",
        apiKey: { source: "env", provider: "default", id: "COHERE_API_KEY" },
      },
    },
  },
}
```

Export the variable before starting OpenClaw:

```bash
export COHERE_API_KEY="your-cohere-api-key"
```

### File

```json5
{
  models: {
    providers: {
      cohere: {
        baseUrl: "https://api.cohere.ai",
        apiKey: { source: "file", provider: "default", id: "/run/secrets/cohere_api_key" },
      },
    },
  },
}
```

### No API key

For local servers (llama.cpp, vLLM) that don't require authentication, omit `apiKey` entirely:

```json5
{
  models: {
    providers: {
      "llamacpp-local": {
        baseUrl: "http://localhost:8080",
      },
    },
  },
}
```

---

## Troubleshooting

### Connection errors

If you see connection errors to the reranking endpoint:

1. Verify the `baseUrl` in `models.providers.<providerId>` is correct and accessible
2. Check that the endpoint supports the `/v1/rerank` path (or matches your `endpointPath`)
3. Ensure `plugins.entries.memory-external-reranker.config.provider` matches your key in `models.providers`
4. Ensure `plugins.entries.memory-external-reranker.config.model` is the provider model ID (without a `provider/` prefix)
5. For localhost/private provider hosts, set `models.providers.<providerId>.request.allowPrivateNetwork: true`
6. Ensure any required API keys are configured in `models.providers.<providerId>.apiKey`
7. Test the endpoint directly with `curl`:

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

1. Check that the part of `model` after the first `/` matches the provider's model ID
2. Check the provider's documentation for available reranker models
3. Try a different model from the `modelFallbacks` list

### Performance issues

To improve reranking performance:

1. Set `topN` to limit the number of results returned
2. Use a smaller model if available (e.g., `rerank-lite-2` instead of `rerank-2`)
3. Consider using a local reranker (llama.cpp, vLLM) for faster response times
