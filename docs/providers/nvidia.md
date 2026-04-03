---
summary: "Use NVIDIA's OpenAI-compatible API in OpenClaw"
read_when:
  - You want to use open models in OpenClaw for free
  - You need NVIDIA_API_KEY setup
title: "NVIDIA"
---

# NVIDIA

NVIDIA provides an OpenAI-compatible API at `https://integrate.api.nvidia.com/v1` for open models for free. Authenticate with an API key from [build.nvidia.com](https://build.nvidia.com/settings/api-keys).

## CLI setup

Export the key once, then run onboarding and set an NVIDIA model:

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/nemotron-3-super-120b-a12b
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
      model: { primary: "nvidia/nvidia/nemotron-3-super-120b-a12b" },
    },
  },
}
```

## Model IDs

- `nvidia/nemotron-3-super-120b-a12b` (default)
- `moonshotai/kimi-k2.5`
- `minimaxai/minimax-m2.5`
- `z-ai/glm5`

## Notes

- OpenAI-compatible `/v1` endpoint; use an API key from [build.nvidia.com](https://build.nvidia.com/).
- Provider auto-enables when `NVIDIA_API_KEY` is set.
