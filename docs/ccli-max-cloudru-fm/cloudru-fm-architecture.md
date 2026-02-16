# Архитектура интеграции Cloud.ru FM в OpenClaw

## Общая схема

```
┌──────────────────────────────────────────────────────────────────────┐
│                         OpenClaw (Node.js)                          │
│                                                                      │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────────┐    │
│  │  Wizard      │   │  Auth-choice │   │  CLI Runner            │    │
│  │  (onboard)   │──▶│  Handler     │──▶│  (runCliAgent)         │    │
│  │              │   │  Chain       │   │                        │    │
│  └─────────────┘   └──────────────┘   └──────────┬─────────────┘    │
│                                                    │                  │
│                                          spawns: claude -p           │
│                                                    │                  │
└────────────────────────────────────────────────────┼─────────────────┘
                                                     │
                                                     ▼
                                          ┌─────────────────────┐
                                          │   Claude Code CLI    │
                                          │   ANTHROPIC_BASE_URL │
                                          │   = localhost:8082   │
                                          └──────────┬──────────┘
                                                     │
                                            HTTP (Anthropic API)
                                                     │
                                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│              claude-code-proxy (Docker контейнер)                   │
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────────┐    │
│  │  Anthropic    │   │  Protocol    │   │  OpenAI-compatible    │    │
│  │  API Listener │──▶│  Translator  │──▶│  API Client           │    │
│  │  :8082        │   │              │   │                       │    │
│  └──────────────┘   └──────────────┘   └───────────┬───────────┘    │
│                                                     │                │
│  Tier mapping:                                      │                │
│    opus   → BIG_MODEL    (env)                      │                │
│    sonnet → MIDDLE_MODEL (env)                      │                │
│    haiku  → SMALL_MODEL  (env)                      │                │
└─────────────────────────────────────────────────────┼────────────────┘
                                                      │
                                              HTTPS (OpenAI API)
                                                      │
                                                      ▼
                                    ┌──────────────────────────────┐
                                    │   Cloud.ru Foundation Models  │
                                    │   API (cloud.ru/v1)           │
                                    │                                │
                                    │   GLM-4.7 / GLM-4.7-Flash    │
                                    │   GLM-4.7-FlashX              │
                                    │   Qwen3-Coder-480B            │
                                    └──────────────────────────────┘
```

## Компоненты системы

### 1. Модуль конфигурации (Config Layer)

**Файл:** `src/config/cloudru-fm.constants.ts`

Единый источник правды (Single Source of Truth) для всех констант:

| Константа | Значение | Назначение |
|-----------|----------|------------|
| `CLOUDRU_FM_MODELS` | 4 модели | Полные ID моделей cloud.ru |
| `CLOUDRU_FM_PRESETS` | 3 пресета | Конфигурации wizard |
| `CLOUDRU_PROXY_PORT_DEFAULT` | `8082` | Порт прокси |
| `CLOUDRU_BASE_URL` | `https://foundation-models.api.cloud.ru/v1` | API endpoint |
| `CLOUDRU_PROXY_IMAGE` | `legard/claude-code-proxy:v1.0.0` | Docker образ (pinned) |
| `CLOUDRU_PROXY_SENTINEL_KEY` | `not-a-real-key-proxy-only` | Заглушка для Claude CLI |
| `CLOUDRU_CLEAR_ENV_EXTRAS` | 6 переменных | Очистка окружения подпроцесса |

### 2. Wizard Handler (Presentation Layer)

**Файл:** `src/commands/auth-choice.apply.cloudru-fm.ts`

Обработчик выбора провайдера в wizard onboarding. Следует паттерну handler-chain:

```
auth-choice.apply.ts
  → handlers[] = [
      applyAuthChoiceAnthropic,
      applyAuthChoiceOpenAI,
      ...11 других...
      applyAuthChoiceCloudruFm,    ◄── наш handler
    ]
```

**Что делает handler:**

1. Guard clause — проверяет `authChoice ∈ {cloudru-fm-glm47, cloudru-fm-flash, cloudru-fm-qwen}`
2. Собирает API-ключ (opts → env → interactive prompt)
3. Записывает provider config в `openclaw.json` (модели, baseUrl)
4. Записывает CLI backend override (`ANTHROPIC_BASE_URL`, sentinel key, `clearEnv`)
5. Устанавливает модель + fallback chain (`opus → sonnet → haiku`)
6. Сохраняет API-ключ в `.env` (НИКОГДА в config)
7. Проверяет доступность прокси (pre-flight health check)

### 3. Onboarding Utilities (Application Layer)

**Файл:** `src/commands/onboard-cloudru-fm.ts`

| Функция | Назначение |
|---------|------------|
| `resolveCloudruModelPreset()` | AuthChoice → CloudruModelPreset |
| `writeDockerComposeFile()` | Генерирует docker-compose YAML |
| `writeCloudruEnvFile()` | Записывает `.env` с API-ключом |
| `ensureGitignoreEntries()` | Добавляет `.env` и compose в `.gitignore` |

### 4. Proxy Template (Infrastructure Layer)

**Файл:** `src/agents/cloudru-proxy-template.ts`

Генерирует security-hardened Docker Compose YAML:
- Pinned image version (не `:latest`)
- Localhost-only binding (`127.0.0.1:8082`)
- `no-new-privileges`, `cap_drop: ALL`, `read_only: true`
- Non-root user (`1000:1000`)
- Health check (10s interval, 5s timeout, 3 retries)
- Resource limits (512 MB RAM, 1 CPU)

### 5. Health Check (Infrastructure Layer)

**Файл:** `src/agents/cloudru-proxy-health.ts`

| Функция | Назначение |
|---------|------------|
| `checkProxyHealth()` | HTTP probe `/health` с 5s timeout, 30s cache |
| `ensureProxyHealthy()` | Throws plain Error если прокси недоступен |
| `clearProxyHealthCache()` | Сброс кэша (для тестов) |

**Архитектурное решение:** Кидает `Error`, а НЕ `FailoverError`, чтобы не запускать бессмысленный цикл fallback через тот же мертвый прокси.

### 6. Rollback (Application Layer)

**Файл:** `src/commands/cloudru-rollback.ts`

Идемпотентная откатка конфигурации wizard:
- Удаляет `ANTHROPIC_BASE_URL` и `ANTHROPIC_API_KEY` из CLI backend env
- Удаляет провайдер `cloudru-fm` из `models.providers`
- НЕ удаляет `.env` и `agents.defaults.model`
- Обрабатывает отсутствие/повреждение config файла

## Типы и интерфейсы

### Type Extensions (src/commands/onboard-types.ts)

```typescript
// Добавлены к AuthChoice union:
| "cloudru-fm-glm47"
| "cloudru-fm-flash"
| "cloudru-fm-qwen"

// Добавлен к AuthChoiceGroupId:
| "cloudru-fm"

// Добавлен к OnboardOptions:
cloudruApiKey?: string;
```

### Preset Type (src/config/cloudru-fm.constants.ts)

```typescript
type CloudruModelPreset = {
  big: string;      // opus tier model ID
  middle: string;   // sonnet tier model ID
  small: string;    // haiku tier model ID
  label: string;    // Human-readable name
  free: boolean;    // Free tier flag
};
```

## Граф зависимостей

```
cloudru-fm.constants.ts          ◄── Single Source of Truth
  ▲           ▲           ▲
  │           │           │
  │     cloudru-proxy-    │
  │     template.ts       │
  │           ▲           │
  │           │           │
onboard-      │     auth-choice.apply.
cloudru-fm.ts─┘     cloudru-fm.ts
  ▲                       │
  │                       │
  └───────────────────────┘ (writeCloudruEnvFile)

cloudru-proxy-health.ts ◄── auth-choice.apply.cloudru-fm.ts
cloudru-rollback.ts     ◄── (standalone, importable)
```

Циклических зависимостей нет. Все стрелки идут к `cloudru-fm.constants.ts`.

## Безопасность

### API-ключ (CLOUDRU_API_KEY)

| Место | Хранение | Безопасно? |
|-------|----------|------------|
| `.env` файл | На диске, рядом с docker-compose | Да (в `.gitignore`) |
| `openclaw.json` | НИКОГДА | Да |
| Docker env | `${CLOUDRU_API_KEY}` reference | Да (не hardcoded) |
| Claude CLI процесс | Очищается через `clearEnv` | Да |
| Git | В `.gitignore` | Да |

### Сетевая изоляция

```
Internet ──✖──▶ localhost:8082    (внешний доступ запрещен)
localhost  ──✔──▶ localhost:8082    (только локальные запросы)
Container  ──✔──▶ cloud.ru API     (исходящий HTTPS)
```

### Subprocess Environment

`clearEnv` очищает 8 переменных окружения в подпроцессе Claude CLI:
- `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_OLD`
- `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`
- `AWS_SECRET_ACCESS_KEY`, `AZURE_OPENAI_API_KEY`
- `CLOUDRU_API_KEY`

## Модель маппинга (Tier Mapping)

```
┌────────────────────────┐      ┌──────────────────────────┐
│   Claude Code Tiers    │      │   Cloud.ru FM Models     │
│                        │      │                          │
│   opus  ──────────────────▶   BIG_MODEL                 │
│   sonnet ─────────────────▶   MIDDLE_MODEL              │
│   haiku  ─────────────────▶   SMALL_MODEL               │
└────────────────────────┘      └──────────────────────────┘
```

Три пресета:

| Пресет | opus (BIG) | sonnet (MIDDLE) | haiku (SMALL) | Бесплатно |
|--------|-----------|-----------------|---------------|-----------|
| GLM-4.7 (Full) | GLM-4.7 | GLM-4.7-FlashX | GLM-4.7-Flash | Нет |
| GLM-4.7-Flash (Free) | GLM-4.7-Flash | GLM-4.7-Flash | GLM-4.7-Flash | Да |
| Qwen3-Coder-480B | Qwen3-Coder-480B | GLM-4.7-FlashX | GLM-4.7-Flash | Нет |

## Fallback Strategy

```
Запрос → opus (BIG_MODEL)
           │ fail
           ▼
         sonnet (MIDDLE_MODEL)
           │ fail
           ▼
         haiku (SMALL_MODEL)
           │ fail
           ▼
         ERROR (пользователю)
```

Fallback работает на уровне Claude Code tier (не на уровне cloud.ru моделей), через `agents.defaults.model.fallbacks` в `openclaw.json`.
