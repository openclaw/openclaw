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
- Install route: npm; ClawHub

## Surface

contracts: memoryRerankers

## Configuration

Configure the plugin under `plugins.entries.memory-external-reranker.config`:

```json
{
  "plugins": {
    "entries": {
      "memory-external-reranker": {
        "enabled": true,
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

`endpointPath` defaults to `/v1/rerank` when omitted.

Runtime URL join behavior: OpenClaw sends requests to
`models.providers.<provider>.baseUrl + endpointPath`. If a provider `baseUrl`
already ends with `/v1`, set `endpointPath` to `/rerank` (or remove `/v1` from
the provider `baseUrl`) to avoid `/v1/v1/rerank`.

<Warning>
  The reranker forwards the user query and candidate memory snippets to the configured endpoint
  and can include the provider API key. Review egress, logging, retention, redaction, and
  SSRF/private-network policy before treating this as an approved deployment.
</Warning>

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
