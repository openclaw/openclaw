---
summary: "OpenClaw میں Synthetic کے Anthropic-مطابقت پذیر API کا استعمال کریں"
read_when:
  - آپ Synthetic کو ماڈل فراہم کنندہ کے طور پر استعمال کرنا چاہتے ہیں
  - آپ کو Synthetic API کلید یا بیس URL سیٹ اپ درکار ہے
title: "Synthetic"
---

# Synthetic

Synthetic Anthropic-compatible endpoints فراہم کرتا ہے۔ OpenClaw اسے `synthetic` provider کے طور پر رجسٹر کرتا ہے اور Anthropic Messages API استعمال کرتا ہے۔

## فوری سیٹ اپ

1. `SYNTHETIC_API_KEY` سیٹ کریں (یا نیچے موجود وِزارڈ چلائیں)۔
2. آن بورڈنگ چلائیں:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

بطورِ طے شدہ ماڈل درج ذیل پر سیٹ ہوتا ہے:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## کنفیگ مثال

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

نوٹ: OpenClaw کا Anthropic کلائنٹ بیس URL کے آخر میں `/v1` شامل کرتا ہے، اس لیے `https://api.synthetic.new/anthropic` استعمال کریں (`/anthropic/v1` نہیں)۔ اگر Synthetic اپنا بیس URL تبدیل کرے، تو `models.providers.synthetic.baseUrl` کو override کریں۔

## ماڈل کیٹلاگ

ذیل کے تمام ماڈلز کی لاگت `0` (ان پٹ/آؤٹ پٹ/کیش) استعمال کرتی ہے۔

| ماڈل ID                                                | سیاق ونڈو | زیادہ سے زیادہ ٹوکنز | استدلال | ان پٹ       |
| ------------------------------------------------------ | --------- | -------------------- | ------- | ----------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000    | 65536                | false   | متن         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000    | 8192                 | true    | متن         |
| `hf:zai-org/GLM-4.7`                                   | 198000    | 128000               | false   | متن         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000    | 8192                 | false   | متن         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000    | 8192                 | false   | متن         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000    | 8192                 | false   | متن         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000    | 8192                 | false   | متن         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000    | 8192                 | false   | متن         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000    | 8192                 | false   | متن         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000    | 8192                 | false   | متن         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000    | 8192                 | false   | متن         |
| `hf:openai/gpt-oss-120b`                               | 128000    | 8192                 | false   | متن         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000    | 8192                 | false   | متن         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000    | 8192                 | false   | متن         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000    | 8192                 | false   | متن + تصویر |
| `hf:zai-org/GLM-4.5`                                   | 128000    | 128000               | false   | متن         |
| `hf:zai-org/GLM-4.6`                                   | 198000    | 128000               | false   | متن         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000    | 8192                 | false   | متن         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000    | 8192                 | true    | متن         |

## نوٹس

- ماڈل ریفرنسز `synthetic/<modelId>` استعمال کرتے ہیں۔
- اگر آپ ماڈل اجازت فہرست (`agents.defaults.models`) فعال کرتے ہیں تو ہر وہ ماڈل شامل کریں
  جسے آپ استعمال کرنے کا ارادہ رکھتے ہیں۔
- فراہم کنندہ کے قواعد کے لیے [Model providers](/concepts/model-providers) دیکھیں۔
