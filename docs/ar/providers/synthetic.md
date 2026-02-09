---
summary: "استخدم واجهة برمجة التطبيقات المتوافقة مع Anthropic من Synthetic في OpenClaw"
read_when:
  - تريد استخدام Synthetic كمزوّد نماذج
  - تحتاج إلى إعداد مفتاح واجهة برمجة التطبيقات لـ Synthetic أو عنوان URL الأساسي
title: "Synthetic"
---

# Synthetic

يوفّر Synthetic نقاط نهاية متوافقة مع Anthropic. يقوم OpenClaw بتسجيله
كمزوّد `synthetic` ويستخدم واجهة برمجة تطبيقات Anthropic Messages.

## الإعداد السريع

1. عيّن `SYNTHETIC_API_KEY` (أو شغّل معالج الإعداد أدناه).
2. تشغيل الرحلة:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

يتم تعيين النموذج الافتراضي إلى:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## مثال على التهيئة

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

ملاحظة: يُلحِق عميل Anthropic في OpenClaw القيمة `/v1` بعنوان URL الأساسي، لذا استخدم
`https://api.synthetic.new/anthropic` (وليس `/anthropic/v1`). إذا غيّر Synthetic
عنوان URL الأساسي الخاص به، فتجاوز `models.providers.synthetic.baseUrl`.

## كتالوج النماذج

تستخدم جميع النماذج أدناه التكلفة `0` (إدخال/إخراج/ذاكرة مؤقتة).

| معرف النموذج                                           | نافذة السياق | الحد الأقصى للرموز | الاستدلال | الإدخال   |
| ------------------------------------------------------ | ------------ | ------------------ | --------- | --------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000       | 65536              | false     | نص        |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000       | 8192               | true      | نص        |
| `hf:zai-org/GLM-4.7`                                   | 198000       | 128000             | false     | نص        |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000       | 8192               | false     | نص        |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000       | 8192               | false     | نص        |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000       | 8192               | false     | نص        |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000       | 8192               | false     | نص        |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000       | 8192               | false     | نص        |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000       | 8192               | false     | نص        |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000       | 8192               | false     | نص        |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000       | 8192               | false     | نص        |
| `hf:openai/gpt-oss-120b`                               | 128000       | 8192               | false     | نص        |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000       | 8192               | false     | نص        |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000       | 8192               | false     | نص        |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000       | 8192               | false     | نص + صورة |
| `hf:zai-org/GLM-4.5`                                   | 128000       | 128000             | false     | نص        |
| `hf:zai-org/GLM-4.6`                                   | 198000       | 128000             | false     | نص        |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000       | 8192               | false     | نص        |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000       | 8192               | true      | نص        |

## ملاحظات

- تستخدم مراجع النماذج `synthetic/<modelId>`.
- إذا قمت بتمكين قائمة السماح للنماذج (`agents.defaults.models`)، فأضِف كل نموذج
  تخطط لاستخدامه.
- راجع [مزوّدو النماذج](/concepts/model-providers) لمعرفة قواعد المزوّد.
