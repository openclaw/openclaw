# @openclaw/memory-external-reranker

Official external memory reranker plugin for OpenClaw.

This plugin proxies memory reranking to Cohere-compatible `/v1/rerank` endpoints, including hosted providers and self-hosted/local deployments.

## Install

```bash
openclaw plugins install @openclaw/memory-external-reranker
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- Memory reranker plugin id: `memory-external-reranker`
- Cohere-compatible reranking integration via provider config
- Optional model fallback chain (`modelFallbacks`)

## Configure

Configure provider credentials and network policy under `models.providers.<id>`, then configure plugin selection under `plugins.entries.memory-external-reranker`.

Full configuration and examples:

- https://docs.openclaw.ai/plugins/memory-external-reranker

## Package

- Plugin id: `memory-external-reranker`
- Package: `@openclaw/memory-external-reranker`
- Minimum OpenClaw host: `2026.6.2`
