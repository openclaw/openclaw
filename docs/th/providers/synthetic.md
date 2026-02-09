---
summary: "ใช้APIที่เข้ากันได้กับAnthropicของSyntheticในOpenClaw"
read_when:
  - คุณต้องการใช้Syntheticเป็นผู้ให้บริการโมเดล
  - คุณต้องการตั้งค่าคีย์APIหรือbase URLของSynthetic
title: "Synthetic"
---

# Synthetic

Synthetic เปิดเผยเอ็นด์พอยต์ที่เข้ากันได้กับ Anthropic Syntheticเปิดให้ใช้งานเอ็นด์พอยต์ที่เข้ากันได้กับAnthropic OpenClawลงทะเบียนให้เป็นผู้ให้บริการ `synthetic` และใช้งานAnthropic Messages API

## Quick setup

1. ตั้งค่า `SYNTHETIC_API_KEY` (หรือรันวิซาร์ดด้านล่าง)
2. รันการเริ่มต้นใช้งาน:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

โมเดลค่าเริ่มต้นถูกตั้งค่าเป็น:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Config example

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

หมายเหตุ: ไคลเอนต์AnthropicของOpenClawจะต่อ `/v1` ต่อท้ายbase URL ดังนั้นให้ใช้
`https://api.synthetic.new/anthropic` (ไม่ใช่ `/anthropic/v1`) หากSyntheticเปลี่ยน
base URL ให้กำหนดทับ `models.providers.synthetic.baseUrl` หาก Synthetic เปลี่ยน base URL ให้แทนที่ค่า `models.providers.synthetic.baseUrl`

## Model catalog

โมเดลทั้งหมดด้านล่างใช้ต้นทุน `0` (อินพุต/เอาต์พุต/แคช)

| Model ID                                               | Context window | Max tokens | Reasoning | Input        |
| ------------------------------------------------------ | -------------- | ---------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536      | false     | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192       | true      | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192       | false     | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192       | false     | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192       | false     | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000     | false     | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192       | true      | text         |

## Notes

- การอ้างอิงโมเดลใช้ `synthetic/<modelId>`
- หากคุณเปิดใช้งานรายการอนุญาตของโมเดล (`agents.defaults.models`) ให้เพิ่มทุกโมเดลที่คุณ
  วางแผนจะใช้งาน
- ดู [Model providers](/concepts/model-providers) สำหรับกฎของผู้ให้บริการ
