---
read_when:
  - 你想将 Synthetic 用作模型提供商
  - 你需要 Synthetic API key 或 base URL 设置
summary: 在 OpenClaw 中使用 Synthetic 的 Anthropic 兼容 API
title: Synthetic
x-i18n:
  generated_at: "2026-03-16T06:27:11Z"
  model: gpt-5.4
  provider: openai
  source_hash: 3a2adb0b831babe3e88b027772167748764d85ee72d402ff759571420a91757f
  source_path: providers/synthetic.md
  workflow: 15
---

# Synthetic

Synthetic 提供与 Anthropic 兼容的端点。OpenClaw 将其注册为
`synthetic` 提供商，并使用 Anthropic Messages API。

## 快速设置

1. 设置 `SYNTHETIC_API_KEY`（或运行下面的向导）。
2. 运行新手引导：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

默认模型会设置为：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.5
```

## 配置示例

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
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
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
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

注意：OpenClaw 的 Anthropic 客户端会将 `/v1` 追加到 base URL 后面，因此请使用
`https://api.synthetic.new/anthropic`（而不是 `/anthropic/v1`）。如果 Synthetic 更改了
其 base URL，请覆盖 `models.providers.synthetic.baseUrl`。

## 模型目录

下面所有模型的成本都为 `0`（输入/输出/缓存）。

| 模型 ID                                                | 上下文窗口 | 最大 tokens | 推理  | 输入         |
| ------------------------------------------------------ | ---------- | ----------- | ----- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.5`                            | 192000     | 65536       | false | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000     | 8192        | true  | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000     | 128000      | false | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000     | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000     | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000     | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000     | 8192        | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000     | 8192        | false | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000     | 8192        | false | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000     | 8192        | false | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000     | 8192        | false | text         |
| `hf:openai/gpt-oss-120b`                               | 128000     | 8192        | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000     | 8192        | false | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000     | 8192        | false | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000     | 8192        | false | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000     | 128000      | false | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000     | 128000      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000     | 8192        | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000     | 8192        | true  | text         |

## 说明

- 模型引用使用 `synthetic/<modelId>`。
- 如果你启用了模型允许列表（`agents.defaults.models`），请添加你
  计划使用的每个模型。
- 有关提供商规则，请参阅 [Model providers](/concepts/model-providers)。
