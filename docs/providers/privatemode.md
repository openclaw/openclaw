# Privatemode

[Privatemode](https://privatemode.ai) is a confidential computing inference service that provides end-to-end encryption for your prompts and completions. Unlike standard cloud APIs, not even Privatemode as the service provider can read your data. It exposes an OpenAI-compatible API via a local proxy that handles encryption transparently.

## How it works

Privatemode uses confidential computing (hardware-based trusted execution environments) to ensure your data is encrypted before it leaves your machine. You run the `privatemode-proxy` locally; all requests from OpenClaw pass through it and are encrypted end-to-end before reaching Privatemode's inference backend.

```
OpenClaw → privatemode-proxy (localhost:8080) → [encrypted] → Privatemode backend
```

## Prerequisites

You need a Privatemode account and API key. Sign up at [privatemode.ai](https://privatemode.ai).

The `privatemode-proxy` must be running before starting OpenClaw. The fastest way is Docker:

```bash
docker run -p 8080:8080 ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest
```

Or with your API key pre-configured so you don't need to pass it per-request:

```bash
docker run -p 8080:8080 ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest \
  --apiKey "$PRIVATEMODE_API_KEY"
```

See the [proxy configuration guide](https://docs.privatemode.ai/guides/proxy-configuration) for TLS, Kubernetes, and other deployment options.

## Quick setup

**Step 1:** Start the proxy:

```bash
docker run -p 8080:8080 ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest
```

**Step 2:** Set your API key:

```bash
export PRIVATEMODE_API_KEY=pm-your-key-here
```

**Step 3:** Start OpenClaw — the `privatemode` provider is auto-detected.

## Supported models

| Model ID | Name | Modalities | Notes |
|---|---|---|---|
| `gemma-3-27b` | Gemma 3 27B | text, image | Multimodal |
| `gpt-oss-120b` | GPT-OSS 120B | text | Large context |
| `qwen3-coder-30b-a3b` | Qwen3-Coder 30B-A3B | text | Reasoning, coding |

Privatemode also supports embeddings (`qwen3-embedding-4b`) and speech-to-text (`whisper-large-v3`, `voxtral-mini-3b`), though these are not yet wired into OpenClaw's provider model list.

## Configuration

### Environment variable (simplest)

```bash
PRIVATEMODE_API_KEY=pm-your-key-here
```

OpenClaw auto-discovers the provider and loads the default model list above.

### Explicit `openclaw.json` config

Use explicit config to override the proxy URL (e.g. if running on a different port), add custom models, or pin a specific model:

```json
{
  "models": {
    "providers": {
      "privatemode": {
        "baseUrl": "http://localhost:8080/v1",
        "apiKey": "${PRIVATEMODE_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "gpt-oss-120b",
            "name": "GPT-OSS 120B",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "privatemode/gpt-oss-120b"
      }
    }
  }
}
```

### Default model

Reference Privatemode models with the `privatemode/` prefix:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "privatemode/gpt-oss-120b",
        "fallbacks": ["privatemode/gemma-3-27b"]
      }
    }
  }
}
```

## Custom proxy port

If you run the proxy on a port other than `8080`, set `baseUrl` explicitly:

```json
{
  "models": {
    "providers": {
      "privatemode": {
        "baseUrl": "http://localhost:9090/v1",
        "apiKey": "${PRIVATEMODE_API_KEY}",
        "api": "openai-completions"
      }
    }
  }
}
```

## Docker Compose

To run the privatemode proxy alongside OpenClaw in Docker Compose, add this service to your `docker-compose.yml`:

```yaml
services:
  privatemode-proxy:
    image: ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest
    ports:
      - "8080:8080"
    command: ["--apiKey", "${PRIVATEMODE_API_KEY}"]
    restart: unless-stopped
```

Then set the `baseUrl` to `http://privatemode-proxy:8080/v1` in your `openclaw.json` when OpenClaw runs in the same compose network.

## Security notes

- The proxy performs cryptographic attestation of the Privatemode deployment before sending any data. Prompts are only encrypted after verification succeeds.
- The proxy requires outbound access to `api.privatemode.ai:443` and `cdn.confidential.cloud:443`.
- All costs default to `$0` since pricing is handled by Privatemode independently.

## References

- [Privatemode documentation](https://docs.privatemode.ai)
- [Proxy configuration guide](https://docs.privatemode.ai/guides/proxy-configuration)
- [Proxy source code](https://github.com/edgelesssys/privatemode-public)
- [Available models](https://docs.privatemode.ai/models/overview)
