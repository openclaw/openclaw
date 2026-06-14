---
summary: "Adds external reranker provider support for Cohere-compatible endpoints"
read_when:
  - You are installing, configuring, or auditing the external reranker plugin
title: "External reranker plugin"
---

# External reranker plugin

Adds external reranker provider support for any Cohere-compatible `/v1/rerank` endpoint.

## Distribution

- Package: `@openclaw/memory-external-reranker`
- Install route: included in OpenClaw

## Surface

contracts: memoryRerankers

## Configuration

Configure the plugin under `plugins.entries.memory-external-reranker.config`:

```json
{
  "plugins": {
    "entries": {
      "memory-external-reranker": {
        "config": {
          "provider": "llamacpp",
          "model": "qwen3-reranker",
          "endpointPath": "/v1/rerank"
        }
      }
    }
  }
}
```

Runtime URL join behavior: OpenClaw sends requests to
`models.providers.<provider>.baseUrl + endpointPath`. If a provider `baseUrl`
already ends with `/v1`, set `endpointPath` to `/rerank` (or remove `/v1` from
the provider `baseUrl`) to avoid `/v1/v1/rerank`.

### Private or localhost endpoints

If `models.providers.<provider>.baseUrl` points to localhost or a private IP
(for example `http://localhost:8080` or `http://127.0.0.1:8080`), you must opt
in explicitly:

```json
{
  "plugins": {
    "entries": {
      "memory-external-reranker": {
        "config": {
          "provider": "llamacpp",
          "model": "qwen3-reranker",
          "allowPrivateNetwork": true
        }
      }
    }
  }
}
```

Without this opt-in, reranking fails fast with an explicit configuration error.
