---
summary: "Используйте Anthropic-совместимый API Synthetic в OpenClaw"
read_when:
  - Вы хотите использовать Synthetic как провайдера моделей
  - Вам нужен ключ API Synthetic или настройка базового URL
title: "Synthetic"
---

# Synthetic

Synthetic предоставляет Anthropic-совместимые эндпоинты. OpenClaw регистрирует его
как провайдера `synthetic` и использует Anthropic Messages API.

## Quick setup

1. Задайте `SYNTHETIC_API_KEY` (или запустите мастер ниже).
2. Запустите онбординг:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Модель по умолчанию установлена на:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Пример конфига

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

Примечание: Anthropic-клиент OpenClaw добавляет `/v1` к базовому URL, поэтому используйте
`https://api.synthetic.new/anthropic` (а не `/anthropic/v1`). Если Synthetic изменит
свой базовый URL, переопределите `models.providers.synthetic.baseUrl`.

## Каталог моделей

Все модели ниже используют стоимость `0` (ввод/вывод/кэш).

| ID модели                                              | Окно контекста | Макс. токенов | Рассуждение | Ввод         |
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

## Примечания

- Ссылки на модели используют `synthetic/<modelId>`.
- Если вы включаете список разрешённых моделей (`agents.defaults.models`), добавьте каждую модель,
  которую планируете использовать.
- См. [Model providers](/concepts/model-providers) для правил провайдеров.
