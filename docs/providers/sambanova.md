---
summary: "Use SambaNova built-for-speed inference for LLaMA, Qwen, Deepseek and Gpt models via OpenAI-compatible API"
read_when:
  - You want to use SambaNova inference
  - You need fast model responses
---

# SambaNova

SambaNova provides **fast inference** using their RDU AI accelerator chips, delivering industry-leading speed for popular open-source models through an OpenAI-compatible API.

## CLI setup

```bash
clawdbot onboard --auth-choice sambanova-api-key
# or non-interactive
clawdbot onboard --sambanova-api-key "$SAMBANOVA_API_KEY"
```

## Config snippet

```json5
{
  env: { SAMBANOVA_API_KEY: "......" },
  agents: {
    defaults: {
      model: { primary: "sambanova/Meta-Llama-3.1-8B-Instruct" },
    },
  },
}
```

## Available models

All models run at FP16 or FP16/FP8 precision:

- `sambanova/Llama-4-Maverick-17B-128E-Instruct` - Llama 4 17B
- `sambanova/Meta-Llama-3.3-70B-Instruct` - Llama 3.3 70B
- `sambanova/DeepSeek-V3.1-Terminus` - Deepseek V3.1 Terminus
- `sambanova/gpt-oss-120b` - GPT OSS 120B
- `sambanova/DeepSeek-V3.1` - DeepSeek V3.1
- `sambanova/DeepSeek-V3.2` - DeepSeek V3.2
- `sambanova/DeepSeek-V3-0324` - DeepSeek V3 0324
- `sambanova/Qwen3-32B` - Qwen3 32B
- `sambanova/Qwen3-235B` - Qwen3 235B

## Notes

- Base URL: `https://api.sambanova.ai/v1`
- OpenAI-compatible API (drop-in replacement)
- Model refs use `SAMBANOVA/<model>` format
- Get API key at: https://cloud.sambanova.ai/
- For more model options, see [/concepts/model-providers](/concepts/model-providers)
