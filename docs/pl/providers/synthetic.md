---
summary: "Użyj zgodnego z Anthropic API Synthetic w OpenClaw"
read_when:
  - Chcesz używać Synthetic jako dostawcy modeli
  - Potrzebujesz klucza API Synthetic lub konfiguracji bazowego URL
title: "Synthetic"
---

# Synthetic

Synthetic udostępnia punkty końcowe zgodne z Anthropic. OpenClaw rejestruje go jako
dostawcę `synthetic` i korzysta z API Anthropic Messages.

## Szybka konfiguracja

1. Ustaw `SYNTHETIC_API_KEY` (lub uruchom kreator poniżej).
2. Uruchom onboarding:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Domyślny model jest ustawiony na:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Przykład konfiguracji

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

Uwaga: Klient Anthropic w OpenClaw dołącza `/v1` do bazowego URL, więc użyj
`https://api.synthetic.new/anthropic` (a nie `/anthropic/v1`). Jeśli Synthetic zmieni
swój bazowy URL, nadpisz `models.providers.synthetic.baseUrl`.

## Katalog modeli

Wszystkie modele poniżej używają kosztu `0` (wejście/wyjście/pamięć podręczna).

| ID modelu                                              | Okno kontekstu | Maks. tokenów | Rozumowanie | Wejście      |
| ------------------------------------------------------ | -------------- | ----------------------------- | ----------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536                         | false       | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192                          | true        | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000                        | false       | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192                          | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192                          | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192                          | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192                          | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192                          | false       | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192                          | false       | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192                          | false       | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192                          | false       | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192                          | false       | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192                          | false       | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192                          | false       | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192                          | false       | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000                        | false       | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000                        | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192                          | false       | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192                          | true        | text         |

## Uwagi

- Odwołania do modeli używają `synthetic/<modelId>`.
- Jeśli włączysz listę dozwolonych modeli (`agents.defaults.models`), dodaj każdy model,
  którego planujesz używać.
- Zobacz [Dostawcy modeli](/concepts/model-providers), aby poznać zasady dotyczące dostawców.
