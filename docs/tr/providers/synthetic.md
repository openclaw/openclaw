---
summary: "OpenClaw’da Synthetic’in Anthropic uyumlu API’sini kullanın"
read_when:
  - Synthetic’i bir model sağlayıcısı olarak kullanmak istiyorsunuz
  - Bir Synthetic API anahtarına veya temel URL kurulumuna ihtiyacınız var
title: "Synthetic"
---

# Synthetic

Synthetic, Anthropic uyumlu uç noktalar sunar. OpenClaw bunu
`synthetic` sağlayıcısı olarak kaydeder ve Anthropic Messages API’sini kullanır.

## Hızlı kurulum

1. `SYNTHETIC_API_KEY` ayarlayın (veya aşağıdaki sihirbazı çalıştırın).
2. Onboarding’i çalıştırın:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Varsayılan model şu şekilde ayarlanır:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Yapılandırma örneği

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

Not: OpenClaw’ın Anthropic istemcisi, temel URL’ye `/v1` ekler; bu nedenle
`https://api.synthetic.new/anthropic` kullanın (`/anthropic/v1` değil). Synthetic
temel URL’sini değiştirirse, `models.providers.synthetic.baseUrl` değerini geçersiz kılın.

## Model kataloğu

Aşağıdaki tüm modeller `0` maliyetini kullanır (girdi/çıktı/önbellek).

| Model ID                                               | Bağlam penceresi | Maks. token | Reasoning | Girdi        |
| ------------------------------------------------------ | ---------------- | --------------------------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000           | 65536                       | false     | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000           | 8192                        | true      | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000           | 128000                      | false     | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000           | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000           | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000           | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000           | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000           | 8192                        | false     | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000           | 8192                        | false     | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000           | 8192                        | false     | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000           | 8192                        | false     | text         |
| `hf:openai/gpt-oss-120b`                               | 128000           | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000           | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000           | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000           | 8192                        | false     | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000           | 128000                      | false     | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000           | 128000                      | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000           | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000           | 8192                        | true      | text         |

## Notlar

- Model referansları `synthetic/<modelId>` kullanır.
- Bir model izin listesi (`agents.defaults.models`) etkinleştirirseniz, kullanmayı
  planladığınız her modeli ekleyin.
- Sağlayıcı kuralları için [Model sağlayıcıları](/concepts/model-providers) bölümüne bakın.
