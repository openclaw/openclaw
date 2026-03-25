---
summary: "Use SambaNova fast inference for Llama, DeepSeek, Qwen, and more via OpenAI-compatible API"
read_when:
  - You want to use SambaNova inference
  - You need fast model responses with open-source models
---

# SambaNova

SambaNova provides **fast inference** using their RDU AI accelerator chips, delivering industry-leading speed for popular open-source models through an OpenAI-compatible API.

## CLI setup

```bash
openclaw onboard --auth-choice sambanova-api-key
# or non-interactive
openclaw onboard --sambanova-api-key "$SAMBANOVA_API_KEY"
```

## Config snippet

```json5
{
  env: { SAMBANOVA_API_KEY: "......" },
  agents: {
    defaults: {
      model: { primary: "sambanova/MiniMax-M2.5" },
    },
  },
}
```

## Available models

### DeepSeek

| Model | Input | Output | Reasoning |
|---|---|---|---|
| `sambanova/DeepSeek-R1-0528` | $5.00/M | $7.00/M | Yes |
| `sambanova/DeepSeek-V3-0324` | $3.00/M | $4.50/M | No |
| `sambanova/DeepSeek-V3.1` | $3.00/M | $4.50/M | Yes |
| `sambanova/DeepSeek-V3.1-cb` | $0.15/M | $0.75/M | Yes |
| `sambanova/DeepSeek-V3.1-Terminus` | $3.00/M | $4.50/M | Yes |
| `sambanova/DeepSeek-V3.2` | $3.00/M | $4.50/M | Yes |

### Meta Llama

| Model | Input | Output | Reasoning |
|---|---|---|---|
| `sambanova/Meta-Llama-3.1-8B-Instruct` | $0.10/M | $0.20/M | No |
| `sambanova/Meta-Llama-3.3-70B-Instruct` | $0.60/M | $1.20/M | No |
| `sambanova/Llama-4-Maverick-17B-128E-Instruct` | $0.63/M | $1.80/M | No |
| `sambanova/Llama-3.3-Swallow-70B-Instruct-v0.4` | $0.60/M | $1.20/M | No |

### Qwen

| Model | Input | Output | Reasoning |
|---|---|---|---|
| `sambanova/Qwen3-32B` | $0.40/M | $0.80/M | Yes |
| `sambanova/Qwen3-235B` | $0.40/M | $0.80/M | Yes |

### Other

| Model | Input | Output | Reasoning |
|---|---|---|---|
| `sambanova/MiniMax-M2.5` | $0.30/M | $1.20/M | No |
| `sambanova/gpt-oss-120b` | $0.22/M | $0.59/M | No |

## Notes

- Base URL: `https://api.sambanova.ai/v1`
- OpenAI-compatible API (drop-in replacement)
- Model refs use `sambanova/<model-id>` format
- Vision supported on Llama 4 Maverick (images billed at 6,432 input tokens each)
- New accounts get $5 in free credits
- For more model options, see [/concepts/model-providers](/concepts/model-providers)
