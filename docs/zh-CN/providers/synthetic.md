---
read_when:
  - 你想使用 Synthetic 作为模型提供商
  - 你需要配置 Synthetic API 密钥或 base URL
summary: 在 OpenClaw 中使用 Synthetic 的 Anthropic 兼容 API
title: Synthetic
x-i18n:
  generated_at: "2026-02-01T21:35:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f3f6e3eb864661754cbe2276783c5bc96ae01cb85ee4a19c92bed7863a35a4f7
  source_path: providers/synthetic.md
  workflow: 15
---

# Synthetic

Synthetic 提供兼容 Anthropic 的端点。OpenClaw 将其注册为 `synthetic` 提供商，并使用 Anthropic Messages API。

## 快速设置

1. 设置 `SYNTHETIC_API_KEY`（或运行以下向导）。
2. 运行新手引导：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

默认模型设置为：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 配置示例

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

注意：OpenClaw 的 Anthropic 客户端会自动在 base URL 后追加 `/v1`，因此请使用 `https://api.synthetic.new/anthropic`（而非 `/anthropic/v1`）。如果 Synthetic 更改了其 base URL，请覆盖 `models.providers.synthetic.baseUrl`。

## 模型目录

以下所有模型的费用均为 `0`（输入/输出/缓存）。

| 模型 ID                                                | 上下文窗口 | 最大令牌数 | 推理  | 输入         |
| ------------------------------------------------------ | ---------- | ---------- | ----- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000     | 65536      | false | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000     | 8192       | true  | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000     | 128000     | false | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000     | 8192       | false | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000     | 8192       | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000     | 8192       | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000     | 8192       | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000     | 8192       | false | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000     | 8192       | false | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000     | 8192       | false | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000     | 8192       | false | text         |
| `hf:openai/gpt-oss-120b`                               | 128000     | 8192       | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000     | 8192       | false | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000     | 8192       | false | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000     | 8192       | false | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000     | 128000     | false | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000     | 128000     | false | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000     | 8192       | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000     | 8192       | true  | text         |

## 注意事项

- 模型引用格式为 `synthetic/<modelId>`。
- 如果启用了模型允许列表（`agents.defaults.models`），请添加你计划使用的所有模型。
- 参阅[模型提供商](/concepts/model-providers)了解提供商规则。
