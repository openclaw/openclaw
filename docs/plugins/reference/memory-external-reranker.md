---
summary: "OpenClaw memory reranker plugin that proxies to a Cohere-compatible /v1/rerank endpoint (Cohere, Jina, Voyage, llama.cpp)."
read_when:
  - You are installing, configuring, or auditing the memory-external-reranker plugin
title: "Memory External Reranker plugin"
---

# Memory External Reranker plugin

OpenClaw memory reranker plugin that proxies to a Cohere-compatible /v1/rerank endpoint (Cohere, Jina, Voyage, llama.cpp).

## Distribution

- Package: `@openclaw/memory-external-reranker`
- Install route: npm; ClawHub

## Surface

contracts: memoryRerankers, tools

<!-- openclaw-plugin-reference:manual-start -->

## Configuration

Configure the plugin in `plugins.entries.memory-external-reranker.config`.

- `provider`: provider key in `models.providers`
- `model`: reranker model ID sent to the configured rerank endpoint
- `endpointPath`: rerank HTTP path appended to provider `baseUrl` (default `/v1/rerank`)
- `allowPrivateNetwork`: required when the provider base URL is localhost or a private IP

See [External reranker](/plugins/reference/external-reranker#private-or-localhost-endpoints) for examples.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [memory-external-reranker](/plugins/memory-external-reranker)
