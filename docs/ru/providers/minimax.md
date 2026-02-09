---
summary: "Используйте MiniMax M2.1 в OpenClaw"
read_when:
  - Вам нужны модели MiniMax в OpenClaw
  - Вам нужна помощь по настройке MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax — это компания в области ИИ, которая разрабатывает семейство моделей **M2/M2.1**. Текущий
релиз с фокусом на программирование — **MiniMax M2.1** (23 декабря 2025 г.), созданный для
реальных сложных задач.

Источник: [релиз‑нота MiniMax M2.1](https://www.minimax.io/news/minimax-m21)

## Обзор модели (M2.1)

MiniMax выделяет следующие улучшения в M2.1:

- Более сильное **многоязычное программирование** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Более качественная **веб/приложенческая разработка** и эстетика вывода (включая нативную мобильную).
- Улучшенная обработка **составных инструкций** для офисных рабочих процессов на основе
  чередующегося мышления и интегрированного выполнения ограничений.
- **Более краткие ответы** с меньшим потреблением токенов и более быстрыми циклами итераций.
- Более сильная совместимость с **фреймворками инструментов/агентов** и управление контекстом (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Более высокое качество **диалогов и технического письма**.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Скорость:** Lightning — это «быстрый» вариант в документации по ценам MiniMax.
- **Стоимость:** В ценах указана одинаковая стоимость ввода, но у Lightning выше стоимость вывода.
- **Маршрутизация плана для кодинга:** Бэкенд Lightning недоступен напрямую в MiniMax Coding Plan. MiniMax
  автоматически маршрутизирует большинство запросов на Lightning, но при всплесках трафика
  откатывается на обычный бэкенд M2.1.

## Выбор настройки

### MiniMax OAuth (Coding Plan) — рекомендуется

**Лучше всего подходит для:** быстрой настройки с MiniMax Coding Plan через OAuth, без API‑ключа.

Включите встроенный OAuth‑плагин и выполните аутентификацию:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Вам будет предложено выбрать endpoint:

- **Global** — международные пользователи (`api.minimax.io`)
- **CN** — пользователи в Китае (`api.minimaxi.com`)

Подробности см. в [README плагина MiniMax OAuth](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth).

### MiniMax M2.1 (API‑ключ)

**Лучше всего подходит для:** хостингового MiniMax с Anthropic‑совместимым API.

Настройка через CLI:

- Запустите `openclaw configure`
- Выберите **Model/auth**
- Выберите **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 как резерв (Opus — основной)

**Лучше всего подходит для:** сохранения Opus 4.6 в качестве основного и переключения на MiniMax M2.1 при сбоях.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Необязательно: локально через LM Studio (вручную)

**Лучше всего подходит для:** локального инференса с LM Studio.
Мы наблюдали сильные результаты MiniMax M2.1 на мощном оборудовании (например,
настольный ПК/сервер) при использовании локального сервера LM Studio.

Настройте вручную через `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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

## Настройка через `openclaw configure`

Используйте интерактивный мастер конфигурации, чтобы настроить MiniMax без редактирования JSON:

1. Запустите `openclaw configure`.
2. Выберите **Model/auth**.
3. Выберите **MiniMax M2.1**.
4. При запросе укажите модель по умолчанию.

## Параметры конфигурации

- `models.providers.minimax.baseUrl`: предпочтительно `https://api.minimax.io/anthropic` (Anthropic‑совместимый); `https://api.minimax.io/v1` — необязательно для OpenAI‑совместимых payload.
- `models.providers.minimax.api`: предпочтительно `anthropic-messages`; `openai-completions` — необязательно для OpenAI‑совместимых payload.
- `models.providers.minimax.apiKey`: API‑ключ MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: определить `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: алиасы моделей, которые вы хотите добавить в список разрешённых.
- `models.mode`: оставьте `merge`, если хотите добавить MiniMax наряду со встроенными.

## Примечания

- Ссылки на модели — `minimax/<model>`.
- API использования Coding Plan: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (требуется ключ плана для кодинга).
- Обновляйте значения цен в `models.json`, если нужна точная детализация затрат.
- Реферальная ссылка на MiniMax Coding Plan (скидка 10%): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Правила провайдеров см. в [/concepts/model-providers](/concepts/model-providers).
- Используйте `openclaw models list` и `openclaw models set minimax/MiniMax-M2.1` для переключения.

## Устранение неполадок

### «Unknown model: minimax/MiniMax-M2.1»

Обычно это означает, что **провайдер MiniMax не настроен** (нет записи провайдера
и не найден профиль аутентификации MiniMax/ключ в переменных окружения). Исправление
для этого обнаружения находится в **2026.1.12** (на момент написания ещё не выпущено). Исправьте, выполнив одно из следующих действий:

- Обновитесь до **2026.1.12** (или запустите из исходников `main`), затем перезапустите Gateway (шлюз).
- Запустите `openclaw configure` и выберите **MiniMax M2.1**, или
- Добавьте блок `models.providers.minimax` вручную, или
- Установите `MINIMAX_API_KEY` (или профиль аутентификации MiniMax), чтобы провайдер мог быть подключён.

Убедитесь, что идентификатор модели **чувствителен к регистру**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Затем перепроверьте с помощью:

```bash
openclaw models list
```
