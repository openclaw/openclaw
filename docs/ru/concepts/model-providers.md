---
summary: "Обзор провайдеров моделей с примерами конфигов и CLI‑процессов"
read_when:
  - Вам нужен справочник по настройке моделей для каждого провайдера
  - Вам нужны примеры конфигов или команды CLI для онбординга провайдеров моделей
title: "Провайдеры моделей"
---

# Провайдеры моделей

Эта страница посвящена **провайдерам LLM/моделей** (а не чат‑каналам вроде WhatsApp/Telegram).
Правила выбора моделей см. в [/concepts/models](/concepts/models).

## Краткие правила

- Ссылки на модели используют `provider/model` (пример: `opencode/claude-opus-4-6`).
- Если вы задаёте `agents.defaults.models`, он становится списком разрешённых.
- CLI‑помощники: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Встроенные провайдеры (каталог pi-ai)

OpenClaw поставляется с каталогом pi‑ai. Эти провайдеры **не**
требуют конфига `models.providers`; достаточно настроить аутентификацию и выбрать модель.

### OpenAI

- Провайдер: `openai`
- Аутентификация: `OPENAI_API_KEY`
- Пример модели: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Провайдер: `anthropic`
- Аутентификация: `ANTHROPIC_API_KEY` или `claude setup-token`
- Пример модели: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (вставьте setup-token) или `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Провайдер: `openai-codex`
- Аутентификация: OAuth (ChatGPT)
- Пример модели: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` или `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Провайдер: `opencode`
- Аутентификация: `OPENCODE_API_KEY` (или `OPENCODE_ZEN_API_KEY`)
- Пример модели: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (ключ API)

- Провайдер: `google`
- Аутентификация: `GEMINI_API_KEY`
- Пример модели: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity и Gemini CLI

- Провайдеры: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Аутентификация: Vertex использует gcloud ADC; Antigravity/Gemini CLI используют соответствующие потоки аутентификации
- OAuth Antigravity поставляется как встроенный плагин (`google-antigravity-auth`, по умолчанию отключён).
  - Включить: `openclaw plugins enable google-antigravity-auth`
  - Войти: `openclaw models auth login --provider google-antigravity --set-default`
- OAuth Gemini CLI поставляется как встроенный плагин (`google-gemini-cli-auth`, по умолчанию отключён).
  - Включить: `openclaw plugins enable google-gemini-cli-auth`
  - Войти: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Примечание: вы **не** вставляете client id или secret в `openclaw.json`. Поток входа CLI сохраняет
    токены в профилях аутентификации на хосте шлюза Gateway.

### Z.AI (GLM)

- Провайдер: `zai`
- Аутентификация: `ZAI_API_KEY`
- Пример модели: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Алиасы: `z.ai/*` и `z-ai/*` нормализуются к `zai/*`

### Vercel AI Gateway

- Провайдер: `vercel-ai-gateway`
- Аутентификация: `AI_GATEWAY_API_KEY`
- Пример модели: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Другие встроенные провайдеры

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Пример модели: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Модели GLM на Cerebras используют идентификаторы `zai-glm-4.7` и `zai-glm-4.6`.
  - OpenAI‑совместимый базовый URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Провайдеры через `models.providers` (кастомный/базовый URL)

Используйте `models.providers` (или `models.json`), чтобы добавить **кастомные** провайдеры или
OpenAI/Anthropic‑совместимые прокси.

### Moonshot AI (Kimi)

Moonshot использует OpenAI‑совместимые эндпоинты, поэтому настраивается как кастомный провайдер:

- Провайдер: `moonshot`
- Аутентификация: `MOONSHOT_API_KEY`
- Пример модели: `moonshot/kimi-k2.5`

Идентификаторы моделей Kimi K2:

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding использует Anthropic‑совместимый эндпоинт Moonshot AI:

- Провайдер: `kimi-coding`
- Аутентификация: `KIMI_API_KEY`
- Пример модели: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (бесплатный уровень)

Qwen предоставляет OAuth‑доступ к Qwen Coder + Vision через поток device‑code.
Включите встроенный плагин, затем выполните вход:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Ссылки на модели:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

См. [/providers/qwen](/providers/qwen) для подробностей настройки и примечаний.

### Synthetic

Synthetic предоставляет Anthropic‑совместимые модели через провайдера `synthetic`:

- Провайдер: `synthetic`
- Аутентификация: `SYNTHETIC_API_KEY`
- Пример модели: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

MiniMax настраивается через `models.providers`, поскольку использует кастомные эндпоинты:

- MiniMax (Anthropic‑совместимый): `--auth-choice minimax-api`
- Аутентификация: `MINIMAX_API_KEY`

[/providers/minimax](/providers/minimax) для деталей настройки, вариантов моделей и фрагментов конфига.

### Ollama

Ollama — это локальная среда выполнения LLM, предоставляющая OpenAI‑совместимый API:

- Провайдер: `ollama`
- Аутентификация: не требуется (локальный сервер)
- Пример модели: `ollama/llama3.3`
- Установка: [https://ollama.ai](https://ollama.ai)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama автоматически обнаруживается при локальном запуске по адресу `http://127.0.0.1:11434/v1`. См. [/providers/ollama](/providers/ollama) для рекомендаций по моделям и кастомной конфигурации.

### Локальные прокси (LM Studio, vLLM, LiteLLM и т. п.)

Пример (OpenAI‑совместимый):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Примечания:

- Для кастомных провайдеров параметры `reasoning`, `input`, `cost`, `contextWindow` и `maxTokens` необязательны.
  Если они опущены, OpenClaw по умолчанию использует:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Рекомендуется задавать явные значения, соответствующие ограничениям вашего прокси/модели.

## Примеры CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

См. также: [/gateway/configuration](/gateway/configuration) — полные примеры конфигурации.
