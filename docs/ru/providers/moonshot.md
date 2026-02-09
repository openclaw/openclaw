---
summary: "Настройка Moonshot K2 vs Kimi Coding (отдельные провайдеры и ключи)"
read_when:
  - Вам нужна настройка Moonshot K2 (Moonshot Open Platform) vs Kimi Coding
  - Вам нужно понять различия отдельных эндпоинтов, ключей и ссылок на модели
  - Вам нужен конфиг для копирования/вставки для любого провайдера
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot предоставляет API Kimi с эндпоинтами, совместимыми с OpenAI. Настройте
провайдера и задайте модель по умолчанию `moonshot/kimi-k2.5`, либо используйте
Kimi Coding с `kimi-coding/k2p5`.

Текущие идентификаторы моделей Kimi K2:

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

Примечание: Moonshot и Kimi Coding — это отдельные провайдеры. Ключи не взаимозаменяемы, эндпоинты различаются, и ссылки на модели различаются (Moonshot использует `moonshot/...`, Kimi Coding использует `kimi-coding/...`).

## Фрагмент конфига (Moonshot API)

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

## Примечания

- Ссылки на модели Moonshot используют `moonshot/<modelId>`. Ссылки на модели Kimi Coding используют `kimi-coding/<modelId>`.
- При необходимости переопределите метаданные ценообразования и контекста в `models.providers`.
- Если Moonshot публикует иные ограничения контекста для модели, скорректируйте
  `contextWindow` соответствующим образом.
- Используйте `https://api.moonshot.ai/v1` для международного эндпоинта и `https://api.moonshot.cn/v1` для эндпоинта в Китае.
