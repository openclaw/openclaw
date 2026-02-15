---
summary: "在 OpenClaw 中使用 Synthetic 的 Anthropic 相容 API"
read_when:
  - 您想使用 Synthetic 作為模型供應商時
  - 您需要設定 Synthetic API 金鑰或基礎 URL 時
title: "Synthetic"
---

# Synthetic

Synthetic 暴露 Anthropic 相容的端點。OpenClaw 將其註冊為 `synthetic` 供應商並使用 Anthropic Messages API。

## 快速設定

1.  設定 `SYNTHETIC_API_KEY` (或執行下方的精靈)。
2.  執行新手導覽：

```bash
openclaw onboard --auth-choice synthetic-api-key
```

預設模型設定為：

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 設定範例

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

注意：OpenClaw 的 Anthropic 用戶端會在基礎 URL 後附加 `/v1`，因此請使用 `https://api.synthetic.new/anthropic` (而不是 `/anthropic/v1`)。如果 Synthetic 更改了其基礎 URL，請覆寫 `models.providers.synthetic.baseUrl`。

## 模型目錄

下方所有模型均使用費用 `0` (輸入/輸出/快取)。

| 模型 ID                                                | 上下文視窗 | 最大 Token 數 | 推理能力 | 輸入           |
| :----------------------------------------------------- | :--------- | :------------ | :------- | :------------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000     | 65536         | false    | text           |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000     | 8192          | true     | text           |
| `hf:zai-org/GLM-4.7`                                   | 198000     | 128000        | false    | text           |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000     | 8192          | false    | text           |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000     | 8192          | false    | text           |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000     | 8192          | false    | text           |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000     | 8192          | false    | text           |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000     | 8192          | false    | text           |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000     | 8192          | false    | text           |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000     | 8192          | false    | text           |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000     | 8192          | false    | text           |
| `hf:openai/gpt-oss-120b`                               | 128000     | 8192          | false    | text           |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000     | 8192          | false    | text           |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000     | 8192          | false    | text           |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000     | 8192          | false    | text + image   |
| `hf:zai-org/GLM-4.5`                                   | 128000     | 128000        | false    | text           |
| `hf:zai-org/GLM-4.6`                                   | 198000     | 128000        | false    | text           |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000     | 8192          | false    | text           |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000     | 8192          | true     | text           |

## 注意事項

- 模型參考使用 `synthetic/<modelId>`。
- 如果您啟用模型允許清單 (`agents.defaults.models`)，請新增您計劃使用的每個模型。
- 請參閱 [模型供應商](/concepts/model-providers) 以了解供應商規則。
