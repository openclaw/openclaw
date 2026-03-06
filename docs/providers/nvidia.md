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
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

OpenClaw model refs still use `provider/model`, so NVIDIA configs should keep the
leading `nvidia/` provider prefix. NVIDIA NIM model IDs can themselves contain
slashes, so a valid OpenClaw ref can look doubled, such as
`nvidia/nvidia/llama-3.1-nemotron-70b-instruct` or `nvidia/moonshotai/kimi-k2.5`.
OpenClaw parses model refs on the first `/`, keeps `nvidia` as the provider, and
sends the full remaining NVIDIA model ID (`nvidia/llama-3.1-nemotron-70b-instruct`,
`moonshotai/kimi-k2.5`, and so on) to the NVIDIA API.

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
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## Model IDs

- `nvidia/llama-3.1-nemotron-70b-instruct` (default)
- `moonshotai/kimi-k2.5`
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## Notes

- OpenAI-compatible `/v1` endpoint; use an API key from NVIDIA NGC.
- Provider auto-enables when `NVIDIA_API_KEY` is set; uses static defaults (131,072-token context window, 4,096 max tokens).
