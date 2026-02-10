---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Synthetic's Anthropic-compatible API in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Synthetic as a model provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a Synthetic API key or base URL setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Synthetic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Synthetic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Synthetic exposes Anthropic-compatible endpoints. OpenClaw registers it as the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`synthetic` provider and uses the Anthropic Messages API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set `SYNTHETIC_API_KEY` (or run the wizard below).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Run onboarding:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice synthetic-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The default model is set to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
synthetic/hf:MiniMaxAI/MiniMax-M2.1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { SYNTHETIC_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      synthetic: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.synthetic.new/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${SYNTHETIC_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "hf:MiniMaxAI/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 192000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 65536,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: OpenClaw's Anthropic client appends `/v1` to the base URL, so use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`https://api.synthetic.new/anthropic` (not `/anthropic/v1`). If Synthetic changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
its base URL, override `models.providers.synthetic.baseUrl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model catalog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All models below use cost `0` (input/output/cache).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model ID                                               | Context window | Max tokens | Reasoning | Input        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------------------ | -------------- | ---------- | --------- | ------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536      | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192       | true      | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000     | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192       | false     | text + image |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000     | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000     | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192       | false     | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192       | true      | text         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs use `synthetic/<modelId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you enable a model allowlist (`agents.defaults.models`), add every model you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plan to use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Model providers](/concepts/model-providers) for provider rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
