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
- Install route: included in OpenClaw

## Surface

contracts: memoryRerankers, tools

## Configuration

Configure the plugin in `plugins.memory-external-reranker`.

- `provider`: provider key in `models.providers`
- `model`: reranker model ID sent to `/v1/rerank`
- `allowPrivateNetwork`: required when the provider base URL is localhost or a private IP

See [External reranker](/plugins/reference/external-reranker#private-or-localhost-endpoints) for examples.
