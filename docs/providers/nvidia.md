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

Export the key once, then run onboarding and set an NVIDIA model:

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/llama-3.1-nemotron-70b-instruct
```

If you still pass `--token`, remember it lands in shell history and `ps` output; prefer the env var when possible.

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
      // Note: Use bare model ID (without nvidia/ prefix) for NVIDIA NIM API
      model: { primary: "llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## Model ID Format

**Important**: While OpenClaw generally uses the `provider/model-id` format, NVIDIA NIM API requires **bare model IDs** (without the `nvidia/` prefix) in API calls.

- ❌ Incorrect: `nvidia/moonshotai/kimi-k2.5`
- ✅ Correct: `moonshotai/kimi-k2.5`

When configuring NVIDIA models in `agents.defaults.model.primary`, use the bare model ID without the provider prefix. OpenClaw will automatically route to the NVIDIA provider.

## Model IDs

- `llama-3.1-nemotron-70b-instruct` (default)
- `meta/llama-3.3-70b-instruct`
- `mistral-nemo-minitron-8b-8k-instruct`

## Notes

- OpenAI-compatible `/v1` endpoint; use an API key from NVIDIA NGC.
- Provider auto-enables when `NVIDIA_API_KEY` is set; uses static defaults (131,072-token context window, 4,096 max tokens).
- **Use bare model IDs** (without `nvidia/` prefix) for NVIDIA NIM API compatibility.
