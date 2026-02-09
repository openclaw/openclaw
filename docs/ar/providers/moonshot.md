---
summary: "تهيئة Moonshot K2 مقابل Kimi Coding (موفّران ومفاتيح منفصلة)"
read_when:
  - تريد إعداد Moonshot K2 (منصة Moonshot المفتوحة) مقابل Kimi Coding
  - تحتاج إلى فهم نقاط النهاية والمفاتيح ومراجع النماذج المنفصلة
  - تريد تهيئة جاهزة للنسخ/اللصق لأيٍّ من الموفّرَين
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

توفّر Moonshot واجهة برمجة تطبيقات Kimi مع نقاط نهاية متوافقة مع OpenAI. قم بتهيئة
الموفّر وتعيين النموذج الافتراضي إلى `moonshot/kimi-k2.5`، أو استخدم
Kimi Coding مع `kimi-coding/k2p5`.

معرّفات نماذج Kimi K2 الحالية:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

ملاحظة: Moonshot وKimi Coding موفّران منفصلان. المفاتيح غير قابلة للتبادل، ونقاط النهاية مختلفة، وكذلك مراجع النماذج (تستخدم Moonshot `moonshot/...`، بينما يستخدم Kimi Coding `kimi-coding/...`).

## مقتطف تهيئة (واجهة Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## ملاحظات

- تستخدم مراجع نماذج Moonshot `moonshot/<modelId>`. وتستخدم مراجع نماذج Kimi Coding `kimi-coding/<modelId>`.
- يمكنك تجاوز بيانات التسعير والبيانات الوصفية للسياق في `models.providers` عند الحاجة.
- إذا نشرت Moonshot حدود سياق مختلفة لأحد النماذج، فاضبط
  `contextWindow` وفقًا لذلك.
- استخدم `https://api.moonshot.ai/v1` لنقطة النهاية الدولية، و`https://api.moonshot.cn/v1` لنقطة نهاية الصين.
