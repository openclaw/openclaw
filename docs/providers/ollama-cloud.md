---
summary: "Use Ollama Cloud directly with OpenClaw"
read_when:
  - You want to use hosted Ollama models without a local Ollama server
  - You need the ollama-cloud provider id, key, or endpoint
title: "Ollama Cloud"
---

Ollama Cloud is a first-class hosted provider id for Ollama's cloud API. Use
provider id `ollama-cloud` and model refs like `ollama-cloud/kimi-k2.6`.

Use this page when you want cloud-only routing. For local Ollama, hybrid
cloud-plus-local routing, embeddings, and custom host details, see
[Ollama](/providers/ollama).

## Setup

Create an Ollama Cloud API key at [ollama.com/settings/keys](https://ollama.com/settings/keys), then run:

```bash
openclaw onboard --auth-choice ollama-cloud
```

Or set:

```bash
export OLLAMA_API_KEY="<your-ollama-cloud-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `ollama-cloud`
- Base URL: `https://ollama.com`
- Env var: `OLLAMA_API_KEY`
- API style: Ollama native `/api/chat`
- Example model: `ollama-cloud/kimi-k2.6`

## Models

OpenClaw discovers Ollama Cloud models from the live hosted catalog. Commonly
available hosted ids include:

- `ollama-cloud/gpt-oss:20b`
- `ollama-cloud/kimi-k2.6`
- `ollama-cloud/deepseek-v4-flash`
- `ollama-cloud/minimax-m2.7`
- `ollama-cloud/glm-5`

Use a model id from your current hosted catalog:

```bash
openclaw models list --provider ollama-cloud
openclaw models set ollama-cloud/kimi-k2.6
```

## Live test

For Ollama Cloud API-key smoke tests, point the Ollama live test at the hosted
endpoint and choose a model from your current catalog:

```bash
export OLLAMA_API_KEY="<your-ollama-cloud-api-key>" # pragma: allowlist secret

OPENCLAW_LIVE_TEST=1 \
OPENCLAW_LIVE_OLLAMA=1 \
OPENCLAW_LIVE_OLLAMA_BASE_URL=https://ollama.com \
OPENCLAW_LIVE_OLLAMA_MODEL=kimi-k2.6 \
OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=1 \
pnpm test:live -- extensions/ollama/ollama.live.test.ts
```

The cloud smoke runs text, native stream, and web search. It skips embeddings by
default for `https://ollama.com` because Ollama Cloud API keys may not authorize
`/api/embed`.

## Related

- [Ollama](/providers/ollama)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
