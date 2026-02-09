---
summary: "Använd Synthetics Anthropic-kompatibla API i OpenClaw"
read_when:
  - Du vill använda Synthetic som modellleverantör
  - Du behöver en Synthetic API-nyckel eller bas-URL-konfiguration
title: "Synthetic"
---

# Synthetic

Syntetiska exponerar Anthropic-kompatibla slutpunkter. OpenClaw registrerar det som
`synthetic`-leverantören och använder API:et för antropiska meddelanden.

## Snabbstart

1. Ställ in `SYNTHETIC_API_KEY` (eller kör guiden nedan).
2. Kör introduktionen:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Standardmodellen är inställd på:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Konfigexempel

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

Obs: OpenClaws Antropiska klient lägger till `/v1` till bas-URL, så använd
`https://api.synthetic.new/anthropic` (inte `/anthropic/v1`). Om Syntetiska ändrar
sin bas-URL, åsidosätt `models.providers.synthetic.baseUrl`.

## Modellkatalog

Alla modeller nedan använder kostnad `0` (inmatning/utmatning/cache).

| Modell-ID                                              | Kontextfönster | Max tokens | Resonemang | Indata      |
| ------------------------------------------------------ | -------------- | ---------- | ---------- | ----------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536      | false      | text        |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192       | true       | text        |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000     | false      | text        |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192       | false      | text        |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192       | false      | text        |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192       | false      | text        |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192       | false      | text        |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192       | false      | text        |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192       | false      | text        |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192       | false      | text        |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192       | false      | text        |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192       | false      | text        |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192       | false      | text        |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192       | false      | text        |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192       | false      | text + bild |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000     | false      | text        |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000     | false      | text        |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192       | false      | text        |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192       | true       | text        |

## Noteringar

- Modellreferenser använder `synthetic/<modelId>`.
- Om du aktiverar en tillåtelselista för modeller (`agents.defaults.models`), lägg till varje modell som du
  planerar att använda.
- Se [Model providers](/concepts/model-providers) för leverantörsregler.
