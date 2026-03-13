---
summary: Use Synthetic's Anthropic-compatible API in OpenClaw
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: Synthetic
---

# Synthetic

Synthetic 提供與 Anthropic 相容的端點。OpenClaw 將其註冊為 `synthetic` 供應商，並使用 Anthropic Messages API。

## 快速設定

1. 設定 `SYNTHETIC_API_KEY`（或執行下方的設定精靈）。
2. 執行入門流程：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

預設模型設定為：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.5
```

## 設定範例

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

注意：OpenClaw 的 Anthropic 用戶端會在基底 URL 後附加 `/v1`，因此請使用 `https://api.synthetic.new/anthropic`（而非 `/anthropic/v1`）。若 Synthetic 更改其基底 URL，請覆寫 `models.providers.synthetic.baseUrl`。

## 模型目錄

以下所有模型的費用均為 `0`（輸入/輸出/快取）。

| 模型 ID                                                | 上下文視窗大小 | 最大 token 數 | 是否推理 | 輸入類型    |
| ------------------------------------------------------ | -------------- | ------------- | -------- | ----------- |
| `hf:MiniMaxAI/MiniMax-M2.5`                            | 192000         | 65536         | 否       | 文字        |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192          | 是       | 文字        |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000        | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192          | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192          | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192          | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192          | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192          | 否       | 文字        |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192          | 否       | 文字        |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192          | 否       | 文字        |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192          | 否       | 文字        |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192          | 否       | 文字        |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192          | 否       | 文字        |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192          | 否       | 文字        |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192          | 否       | 文字 + 圖像 |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000        | 否       | 文字        |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000        | 否       | 文字        |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192          | 否       | 文字        |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192          | 是       | 文字        |

## 備註

- 模型參考使用 `synthetic/<modelId>`。
- 若啟用模型允許清單（`agents.defaults.models`），請加入所有計劃使用的模型。
- 詳見 [模型供應商](/concepts/model-providers) 了解供應商規則。
