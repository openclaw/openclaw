---
summary: "Run OpenClaw with Parallax (OpenAI-compatible inference endpoint)"
read_when:
  - You want to run OpenClaw against a Parallax endpoint
  - You want to connect OpenClaw to a local or proxied Parallax server
title: "Parallax"
---

# Parallax

Parallax can expose an OpenAI-compatible inference API. OpenClaw connects to Parallax using the `openai-completions` adapter.

OpenClaw can also auto-discover the active Parallax model when you opt in with `PARALLAX_API_KEY` and the server exposes `GET /v1/models`.

## Quick start

1. Start Parallax and make sure its API is reachable.

Typical endpoints:

- scheduler/frontend mode: `http://127.0.0.1:3001/v1`
- direct head-node mode: `http://127.0.0.1:3000/v1`

2. Opt in:

```bash
export PARALLAX_API_KEY="parallax-local"
```

3. Select a model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "parallax/openai/gpt-oss-20b" },
    },
  },
}
```

## Explicit configuration

```json5
{
  models: {
    providers: {
      parallax: {
        baseUrl: "http://127.0.0.1:3001/v1",
        apiKey: "${PARALLAX_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "openai/gpt-oss-20b",
            name: "Parallax GPT-OSS 20B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Concrete config for `/inference/parallax`

If you expose Parallax behind your own gateway or reverse proxy at `/inference/parallax`, point OpenClaw at the OpenAI-compatible `v1` subpath:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "parallax/openai/gpt-oss-20b",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
      models: {
        "parallax/openai/gpt-oss-20b": { alias: "parallax" },
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      parallax: {
        baseUrl: "https://YOUR_HOST/inference/parallax/v1",
        apiKey: "${PARALLAX_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "openai/gpt-oss-20b",
            name: "Parallax GPT-OSS 20B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

If your reverse proxy strips the `/inference/parallax` prefix before forwarding, use the externally reachable path in `baseUrl`, not the internal upstream path.

## Troubleshooting

- Check discovery: `curl http://127.0.0.1:3001/v1/models`
- Check inference: `curl http://127.0.0.1:3001/v1/chat/completions`
- If you run Parallax without the scheduler UI, override the base URL to `http://127.0.0.1:3000/v1`
