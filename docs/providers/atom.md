---
summary: "Run OpenClaw with ATOM (OpenAI-compatible server optimized for AMD GPUs)"
read_when:
  - You want to run OpenClaw against a local ATOM server
  - You want an OpenAI-compatible server optimized for AMD GPUs
title: "ATOM"
---

# ATOM

[ATOM](https://github.com/ROCm/atom) is an **OpenAI-compatible** LLM inference server optimized for AMD GPUs.
OpenClaw can connect to ATOM using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from ATOM when you opt
in with `ATOM_API_KEY` (any value works if your server does not enforce auth)
and you do not define an explicit `models.providers.atom` entry.

## Quick start

1. Start an ATOM server:

```bash
python -m atom.entrypoints.openai_server \
  --model Qwen/Qwen3-32B \
  --trust-remote-code -tp 8 --kv_cache_dtype fp8
```

2. Set the API key (any value works for local servers):

```bash
export ATOM_API_KEY=atom-local
```

3. OpenClaw will auto-discover available models from the ATOM server at `http://127.0.0.1:8000/v1`.

## Configuration

### Auto-Discovery

When `ATOM_API_KEY` is set, OpenClaw queries `GET http://127.0.0.1:8000/v1/models` and registers all available models automatically.

### Explicit Configuration

To use a custom host, port, or pin model settings, add to `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "atom": {
        "baseUrl": "http://192.168.1.100:8000/v1",
        "apiKey": "${ATOM_API_KEY}",
        "api": "openai-completions",
        "models": [
          {
            "id": "Qwen/Qwen3-32B",
            "name": "Qwen3-32B",
            "reasoning": true,
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

### Using a Model

```bash
openclaw chat --model atom/Qwen/Qwen3-32B
```

## Supported Models

ATOM supports the following model architectures (among others):

| Model              | Notes                             |
| ------------------ | --------------------------------- |
| DeepSeek V3 / V3.2 | MoE + MLA, FP8/MXFP4 quantization |
| Kimi-K2            | Requires `--trust-remote-code`    |
| Qwen3 / Qwen3-MoE  | Dense and MoE variants            |
| Llama 2/3/3.1      | Standard dense models             |
| Mixtral 8x7B       | MoE                               |

See the [ATOM README](https://github.com/ROCm/atom) for the full list.

## Notes

- ATOM uses the standard OpenAI Chat Completions API (`/v1/chat/completions`)
- Streaming is supported via SSE
- No provider-specific features beyond the OpenAI-compatible API surface
- Default server port is 8000
- A public [performance dashboard](https://rocm.github.io/ATOM/benchmark-dashboard/) is available with nightly benchmark results across supported models
