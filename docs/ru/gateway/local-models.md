---
summary: "Запуск OpenClaw на локальных LLM (LM Studio, vLLM, LiteLLM, пользовательские OpenAI-совместимые эндпоинты)"
read_when:
  - Вам нужно обслуживать модели с собственного GPU-сервера
  - Вы подключаете LM Studio или OpenAI-совместимый прокси
  - Вам нужны самые безопасные рекомендации для локальных моделей
title: "Локальные модели"
---

# Локальные модели

Локальный запуск возможен, но OpenClaw ожидает большой контекст и сильные защиты от prompt injection. Малые видеокарты обрезают контекст и «протекают» по безопасности. Цельтесь высоко: **≥2 полностью укомплектованных Mac Studio или эквивалентный GPU-риг (~$30k+)**. Одна GPU на **24 ГБ** подходит только для более лёгких запросов с повышенной задержкой. Используйте **самый большой / полноразмерный вариант модели, который вы можете запустить**; агрессивно квантованные или «малые» чекпойнты повышают риск prompt injection (см. [Безопасность](/gateway/security)).

## Рекомендуется: LM Studio + MiniMax M2.1 (Responses API, полноразмерная)

Лучший текущий локальный стек. Загрузите MiniMax M2.1 в LM Studio, включите локальный сервер (по умолчанию `http://127.0.0.1:1234`) и используйте Responses API, чтобы отделять рассуждения от финального текста.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Чек-лист настройки**

- Установите LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- В LM Studio скачайте **самую большую доступную сборку MiniMax M2.1** (избегайте «small»/сильно квантованных вариантов), запустите сервер и убедитесь, что `http://127.0.0.1:1234/v1/models` отображает её.
- Держите модель загруженной; «холодная» загрузка добавляет задержку старта.
- При необходимости скорректируйте `contextWindow`/`maxTokens`, если ваша сборка LM Studio отличается.
- Для WhatsApp используйте Responses API, чтобы отправлялся только финальный текст.

Держите хостинговые модели настроенными даже при локальном запуске; используйте `models.mode: "merge"`, чтобы резервные варианты оставались доступными.

### Гибридная конфигурация: хостинг — основной, локальный — резервный

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Локальный приоритет с хостинговой «страховкой»

Поменяйте порядок основного и резервного; оставьте тот же блок провайдеров и `models.mode: "merge"`, чтобы можно было откатиться к Sonnet или Opus, когда локальный сервер недоступен.

### Региональный хостинг / маршрутизация данных

- Хостинговые варианты MiniMax/Kimi/GLM также доступны на OpenRouter с эндпоинтами, закреплёнными за регионом (например, размещённые в США). Выберите региональный вариант там, чтобы трафик оставался в выбранной юрисдикции, продолжая использовать `models.mode: "merge"` для резервов Anthropic/OpenAI.
- «Только локально» — самый сильный путь по приватности; региональная маршрутизация хостинга — компромисс, когда нужны возможности провайдера, но требуется контроль над потоками данных.

## Другие OpenAI-совместимые локальные прокси

vLLM, LiteLLM, OAI-proxy или пользовательские шлюзы подходят, если они предоставляют OpenAI-стиль `/v1` эндпоинт. Замените блок провайдера выше на ваш эндпоинт и ID модели:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Оставьте `models.mode: "merge"`, чтобы хостинговые модели оставались доступными как резервные.

## Устранение неполадок

- Gateway (шлюз) может связаться с прокси? `curl http://127.0.0.1:1234/v1/models`.
- Модель в LM Studio выгружена? Перезагрузите; «холодный» старт — частая причина «зависаний».
- Ошибки контекста? Понизьте `contextWindow` или увеличьте лимит сервера.
- Безопасность: локальные модели обходят фильтры провайдера; держите агентов узкими и включайте уплотнение, чтобы ограничить радиус поражения prompt injection.
