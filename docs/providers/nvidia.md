---
summary: "Use NVIDIA's OpenAI-compatible API in OpenClaw"
read_when:
  - You want to use NVIDIA models in OpenClaw
  - You need NVIDIA_API_KEY setup
title: "NVIDIA"
---

# NVIDIA

NVIDIA provides an OpenAI-compatible API at `https://integrate.api.nvidia.com/v1` for Nemotron and NeMo models. Authenticate with an API key from [NVIDIA NGC](https://catalog.ngc.nvidia.com/).

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider nvidia --token "$NVIDIA_API_KEY"
```

If `NVIDIA_API_KEY` is already exported, you can omit `--token`.

## Config snippet

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## Model IDs

- `nvidia/llama-3.1-nemotron-70b-instruct` (default)
- `nvidia/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## Notes

- OpenAI-compatible `/v1` endpoint; use an API key from NVIDIA NGC.
- Provider auto-enables when `NVIDIA_API_KEY` is set; uses static defaults (131,072-token context window, 4,096 max tokens).
