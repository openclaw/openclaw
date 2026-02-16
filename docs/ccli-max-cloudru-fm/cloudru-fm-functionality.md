# Функциональность интеграции Cloud.ru FM

## Что это такое

Интеграция Cloud.ru Foundation Models в OpenClaw позволяет использовать российские LLM-модели (GLM-4.7, Qwen3-Coder) в качестве бэкенда для Claude Code через локальный Docker-прокси. Claude Code продолжает работать как обычно (tool calling, MCP, multi-step reasoning), но запросы идут к cloud.ru вместо Anthropic API.

## Основные возможности

### 1. Wizard Onboarding

При запуске `npx openclaw onboard` в списке провайдеров появляется группа **Cloud.ru FM** с тремя вариантами:

| Вариант | Описание | Стоимость |
|---------|----------|-----------|
| **GLM-4.7 (Full)** | Полная модель GLM-4.7 (358B MoE), 200K контекст | Платно |
| **GLM-4.7-Flash (Free)** | Быстрая версия, все три тира на одной модели | Бесплатно |
| **Qwen3-Coder-480B** | Специализированная для кода, 128K контекст | Платно |

Wizard выполняет:
1. Запрашивает API-ключ cloud.ru (интерактивно или через `--cloudruApiKey` флаг)
2. Проверяет существующий ключ из `CLOUDRU_API_KEY` env
3. Сохраняет ключ в `.env` (не в config)
4. Настраивает модель provider в `openclaw.json`
5. Настраивает CLI backend override (прокси URL + sentinel key)
6. Устанавливает модель с fallback chain
7. Добавляет `.env` и compose файл в `.gitignore`
8. Проверяет доступность прокси (non-blocking warning)

### 2. Протокольная трансляция

Прокси `claude-code-proxy` выполняет:

| Входящий (Anthropic API) | Исходящий (OpenAI API) |
|--------------------------|------------------------|
| `POST /v1/messages` | `POST /v1/chat/completions` |
| Header: `x-api-key` | Header: `Authorization: Bearer` |
| `anthropic-version: 2023-06-01` | (не требуется) |
| `model: claude-opus-4-6` | `model: zai-org/GLM-4.7` |
| Anthropic tool_use blocks | OpenAI function_calling |
| Streaming: SSE (Anthropic format) | Streaming: SSE (OpenAI format) |

### 3. Модельный маппинг

Трёхуровневый маппинг Claude Code tier → cloud.ru model:

```
┌─────────────────────────────────────────────────┐
│  Claude Code запрашивает "opus"                  │
│  → Прокси читает BIG_MODEL env                  │
│  → Отправляет запрос к zai-org/GLM-4.7          │
│                                                   │
│  Claude Code запрашивает "sonnet"                │
│  → Прокси читает MIDDLE_MODEL env               │
│  → Отправляет запрос к zai-org/GLM-4.7-FlashX   │
│                                                   │
│  Claude Code запрашивает "haiku"                 │
│  → Прокси читает SMALL_MODEL env                │
│  → Отправляет запрос к zai-org/GLM-4.7-Flash    │
└─────────────────────────────────────────────────┘
```

### 4. Fallback Chain

Если запрос к модели верхнего тира падает:

```
opus (GLM-4.7)  ──fail──▶  sonnet (GLM-4.7-FlashX)  ──fail──▶  haiku (GLM-4.7-Flash)  ──fail──▶  ERROR
```

Fallback работает на уровне tier (opus→sonnet→haiku), а НЕ на уровне cloud.ru моделей. Это предотвращает бессмысленные попытки через мёртвый прокси.

### 5. Health Check

Встроенная проверка здоровья прокси:
- HTTP GET `http://localhost:8082/health`
- Timeout: 5 секунд
- Кэш результата: 30 секунд
- Вызывается при onboarding (non-blocking warning)
- Docker healthcheck: интервал 10s, 3 retry

### 6. Rollback

Откатка всех изменений wizard:

```typescript
import { rollbackCloudruFmConfig } from "./cloudru-rollback.js";

await rollbackCloudruFmConfig("/path/to/openclaw.json");
```

**Удаляет:**
- `agents.defaults.cliBackends["claude-cli"].env.ANTHROPIC_BASE_URL`
- `agents.defaults.cliBackends["claude-cli"].env.ANTHROPIC_API_KEY`
- `models.providers["cloudru-fm"]`

**НЕ удаляет:**
- `.env` файл (ключ может использоваться для другого)
- `agents.defaults.model` (мог быть установлен пользователем)
- Docker compose файл
- Docker контейнер

### 7. Безопасность

| Механизм | Реализация |
|----------|------------|
| API-ключ изоляция | Хранится в `.env`, не в config |
| Subprocess очистка | `clearEnv` для 8 переменных |
| Сетевая изоляция | `127.0.0.1` binding |
| Docker hardening | `no-new-privileges`, `cap_drop: ALL`, `read_only` |
| Docker ресурсы | 512 MB RAM, 1 CPU лимит |
| Docker user | Non-root `1000:1000` |
| Git защита | `.env` и compose в `.gitignore` |
| Image pinning | `legard/claude-code-proxy:v1.0.0` (не `:latest`) |

### 8. Non-Interactive Mode

Для CI/CD и автоматизации:

```bash
npx openclaw onboard \
  --auth-choice cloudru-fm-glm47 \
  --cloudruApiKey "sk-..." \
  --non-interactive \
  --accept-risk
```

Или через переменную окружения:

```bash
export CLOUDRU_API_KEY="sk-..."
npx openclaw onboard --auth-choice cloudru-fm-flash --non-interactive --accept-risk
```

## Доступные модели Cloud.ru FM

| Модель | ID | Контекст | Особенности |
|--------|-----|----------|-------------|
| GLM-4.7 | `zai-org/GLM-4.7` | 200K | 358B MoE, thinking mode |
| GLM-4.7-FlashX | `zai-org/GLM-4.7-FlashX` | 200K | Баланс скорость/качество |
| GLM-4.7-Flash | `zai-org/GLM-4.7-Flash` | 200K | Бесплатно, быстро |
| Qwen3-Coder-480B | `Qwen/Qwen3-Coder-480B-A35B-Instruct` | 128K | Специализирован для кода |

## Файлы, создаваемые при установке

| Файл | Назначение | В git? |
|------|------------|--------|
| `openclaw.json` | Конфигурация провайдера + бэкенда | Да |
| `.env` | `CLOUDRU_API_KEY=sk-...` | Нет (`.gitignore`) |
| `docker-compose.cloudru-proxy.yml` | Docker Compose для прокси | Нет (`.gitignore`) |
| `.gitignore` | Обновлён автоматически | Да |

## Ограничения

1. **Thinking mode** отключен (`DISABLE_THINKING=true`) из-за нестабильности GLM-4.7
2. **Extended thinking** (reasoning: true) не поддерживается
3. **Vision/Image input** не поддерживается (только text)
4. Tool calling может быть нестабильным на GLM-4.7 (sglang #15721)
5. Стоимость запросов отображается как 0 (реальная стоимость определяется cloud.ru)
