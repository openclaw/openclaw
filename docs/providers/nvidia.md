---
summary: "Use NVIDIA's OpenAI-compatible API in OpenClaw"
read_when:
  - You want to use open models in OpenClaw for free
  - You need NVIDIA_API_KEY setup
title: "NVIDIA"
---

# NVIDIA

NVIDIA provides an OpenAI-compatible API at `https://integrate.api.nvidia.com/v1` for
open models for free. Authenticate with an API key from
[build.nvidia.com](https://build.nvidia.com/settings/api-keys).

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [build.nvidia.com](https://build.nvidia.com/settings/api-keys).
  </Step>
  <Step title="Export the key and run onboarding">
    ```bash
    export NVIDIA_API_KEY="nvapi-..."
    openclaw onboard --auth-choice skip
    ```
  </Step>
  <Step title="Set an NVIDIA model">
    ```bash
    openclaw models set nvidia/nemotron-3-super-120b-a12b
    ```
  </Step>
</Steps>

<Warning>
If you pass `--token` instead of the env var, the value lands in shell history and
`ps` output. Prefer the `NVIDIA_API_KEY` environment variable when possible.
</Warning>

## Config example

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
      model: { primary: "nvidia/nemotron-3-super-120b-a12b" },
    },
  },
}
```

## Built-in catalog

| Model ref                                  | Name                             | Context | Max output | Multimodal | Reasoning |
| ------------------------------------------ | -------------------------------- | ------- | ---------- | ---------- | --------- |
| `nvidia/nemotron-3-super-120b-a12b`        | NVIDIA Nemotron 3 Super 120B     | 262,144 | 8,192      |            |           |
| `nvidia/nemotron-3-8b-instruct`            | NVIDIA Nemotron 3 8B Instruct    | 131,072 | 8,192      |            |           |
| `nvidia/nemotron-4-340b-instruct`          | NVIDIA Nemotron 4 340B Instruct  | 131,072 | 8,192      |            |           |
| `nvidia/meta/llama-3.3-70b-instruct`       | Meta Llama 3.3 70B Instruct      | 131,072 | 8,192      |            |           |
| `nvidia/meta/llama-4-maverick-17b-128e-instruct` | Meta Llama 4 Maverick 17B | 131,072 | 8,192      | ✓          |           |
| `nvidia/meta/llama-4-scout-17b-16e-instruct` | Meta Llama 4 Scout 17B       | 131,072 | 8,192      | ✓          |           |
| `nvidia/mistralai/mistral-small-3.2-24b-instruct` | Mistral Small 3.2 24B   | 131,072 | 8,192      |            |           |
| `nvidia/mistralai/mixtral-8x22b-instruct-v0.1` | Mistral Mixtral 8x22B      | 65,536  | 8,192      |            |           |
| `nvidia/google/gemma-3-27b-it`             | Google Gemma 3 27B               | 131,072 | 8,192      |            |           |
| `nvidia/microsoft/phi-4`                   | Microsoft Phi-4                  | 16,384  | 8,192      |            |           |
| `nvidia/moonshotai/kimi-k2.5`              | Kimi K2.5                        | 262,144 | 8,192      |            |           |
| `nvidia/minimaxai/minimax-m2.5`            | Minimax M2.5                     | 196,608 | 8,192      |            |           |
| `nvidia/z-ai/glm5`                         | GLM 5                            | 202,752 | 8,192      |            |           |
| `nvidia/qwen/qwen3-235b-a22b-2507`         | Qwen3 235B A22B                  | 131,072 | 8,192      |            |           |
| `nvidia/qwen/qwq-32b`                      | Qwen QWQ 32B                     | 131,072 | 8,192      |            | ✓         |
| `nvidia/deepseek-ai/deepseek-r1-0528`      | DeepSeek R1 0528                 | 131,072 | 8,192      |            | ✓         |

## Advanced notes

<AccordionGroup>
  <Accordion title="Auto-enable behavior">
    The provider auto-enables when the `NVIDIA_API_KEY` environment variable is set.
    No explicit provider config is required beyond the key.
  </Accordion>

  <Accordion title="Catalog and pricing">
    The bundled catalog is static. Costs default to `0` in source since NVIDIA
    currently offers free API access for the listed models.
  </Accordion>

  <Accordion title="OpenAI-compatible endpoint">
    NVIDIA uses the standard `/v1` completions endpoint. Any OpenAI-compatible
    tooling should work out of the box with the NVIDIA base URL.
  </Accordion>
</AccordionGroup>

<Tip>
NVIDIA models are currently free to use. Check
[build.nvidia.com](https://build.nvidia.com/) for the latest availability and
rate-limit details.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
