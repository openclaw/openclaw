# Deep Research: Claude Code vs OpenCode в OpenClaw + Evolution Cloud Foundation Models

## Executive Summary

Данный отчёт анализирует возможности и ограничения использования **Claude Code** и **OpenCode** как агентных CLI-инструментов в рамках **OpenClaw**, работающего исключительно с **cloud.ru Evolution Foundation Models** (прежде всего GLM-4.7-Flash / ZLM-4.7-Flash).

### Ключевой вывод (обновлённый)

**Claude Code МОЖЕТ работать с cloud.ru Foundation Models** через [claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy) — прокси-сервер, транслирующий Anthropic API → OpenAI-совместимый API. Это кардинально меняет сравнение:

| Сценарий | Рекомендация |
|----------|-------------|
| **Agentic coding** (разработка, рефакторинг) | **Claude Code + proxy** — лучший агентный движок, привычный UX |
| **Model experimentation** (тесты разных моделей) | **OpenCode** — нативная смена моделей без перенастройки |
| **Production runtime** (бот в OpenClaw) | **Оба варианта** — через proxy или нативно |
| **Cost-sensitive** / бесплатные модели | **Claude Code + proxy** на GLM-4.7-Flash (free tier) |

---

## 1. Cloud.ru Evolution Foundation Models

### 1.1 Доступные модели (февраль 2026)

| Модель | Параметры | Контекст | Tool Calling | Reasoning | Примечания |
|--------|-----------|----------|--------------|-----------|------------|
| **GLM-4.7** | 358B MoE | 200K | Да | Thinking mode | Топ-модель, SWE-bench 73.8% |
| **GLM-4.7-FlashX** | MoE (легче) | 200K | Да | Да | Быстрая, доступная |
| **GLM-4.7-Flash** | MoE (минимум) | 200K | Да | Да | **Бесплатный тир** |
| GLM-4.6 | Пред. поколение | 128K | Частично | Нет | RLHF-отказы |
| Qwen3-235B | 235B MoE | 128K | Да | Да | Сильная альтернатива |
| Qwen3-Coder-480B | 480B MoE | 128K | Да | Да | Специализация на коде |
| MiniMax-M2 | — | — | Да | — | Универсальная |
| GigaChat-2-Max | — | — | Ограниченно | — | Русскоязычная |
| T-pro-it-2.0 | — | — | Ограниченно | — | Модель T-Bank |

### 1.2 API-архитектура

```
Base URL:     https://foundation-models.api.cloud.ru/v1/
Аутентификация: API Key (сервисный аккаунт → служба Foundation Models)
Формат:       OpenAI-совместимый (/v1/chat/completions)
Rate Limit:   15 запросов/сек на ключ
Возможности:  Streaming, Function Calling, Structured Output, Reasoning
```

### 1.3 Почему нужен API-шлюз / прокси

Несмотря на заявленную OpenAI-совместимость, инсайты из demo-инсталляции выявили критические несовместимости:

#### Проблема 1: Аутентификация
- **Claude Code отправляет**: Anthropic-формат (`x-api-key`, `anthropic-version`)
- **Cloud.ru ожидает**: OpenAI-формат (`Authorization: Bearer ...`)
- **Решение**: claude-code-proxy транслирует формат автоматически

#### Проблема 2: Маппинг моделей
- **Claude Code запрашивает**: `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- **Cloud.ru использует**: `zai-org/GLM-4.7`, `Qwen/Qwen3-Coder-480B`, `MiniMaxAI/MiniMax-M2`
- **Решение**: Переменные `BIG_MODEL`, `MIDDLE_MODEL`, `SMALL_MODEL` в прокси

#### Проблема 3: Tool Calling поведение
- **GLM-4.7-Flash** иногда игнорирует `<available_skills>` XML-секции (Insight #043-045)
- **GLM** может симулировать tool calls в тексте вместо структурных вызовов (Insight #055)
- **Streaming tool calls**: Известные баги с дублированием `<tool_call>` тегов (sglang issue #15721)
- **Решение**: Прокси нормализует tool_call формат; отключить thinking mode для стабильности

#### Проблема 4: Особенности ответов
- GLM-4.6 имел hardcoded RLHF-отказы (Insight #046)
- System prompts >4,000 символов теряют внимание модели
- **Решение**: Сжатие промптов, критические инструкции — в первую строку

---

## 2. Claude Code + claude-code-proxy: Полное решение

### 2.1 Как это работает

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────────┐
│  Claude Code │     │  claude-code-proxy  │     │  cloud.ru Foundation │
│  CLI         │────▶│  (Python/Docker)    │────▶│  Models API          │
│              │     │                     │     │                      │
│  Anthropic   │     │  Anthropic → OpenAI │     │  /v1/chat/completions│
│  protocol    │     │  format translation │     │                      │
│              │     │  model mapping      │     │                      │
│              │     │  tool call convert  │     │                      │
└──────────────┘     └────────────────────┘     └──────────────────────┘
```

### 2.2 Настройка (из cloud.ru wiki)

**docker-compose.yml:**
```yaml
services:
  claude-code-proxy:
    image: legard/claude-code-proxy:v1.0.0  # Pinned version, not :latest
    container_name: claude-code-proxy
    ports:
      - "127.0.0.1:8082:8082"    # Только localhost!
      - "[::1]:8082:8082"
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8082/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

**.env (минимальная конфигурация):**
```bash
OPENAI_API_KEY="<ваш-api-key-cloud.ru>"
OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1"

# Маппинг моделей Claude → cloud.ru
BIG_MODEL="zai-org/GLM-4.7"              # Claude Opus → GLM-4.7
MIDDLE_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct"  # Claude Sonnet → Qwen3 Coder
SMALL_MODEL="zai-org/GLM-4.7-Flash"      # Claude Haiku → GLM-4.7-Flash (бесплатно!)

HOST="0.0.0.0"
PORT="8082"
LOG_LEVEL="INFO"
```

**Настройка Claude Code CLI:**
```bash
# Способ 1: Через переменные окружения
export ANTHROPIC_BASE_URL=http://localhost:8082
export ANTHROPIC_API_KEY="any-key"
claude

# Способ 2: Через settings файл (рекомендуется)
# ~/.claude/settings-fm.json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "http://localhost:8082"
  },
  "model": "opus"
}

# Alias для удобства
alias claude-fm='claude --settings ~/.claude/settings-fm.json'
```

### 2.3 Что поддерживает прокси

| Функция | Статус | Примечания |
|---------|--------|------------|
| Chat completions | ✅ Полная | Anthropic → OpenAI конвертация |
| Streaming (SSE) | ✅ Полная | Real-time |
| Tool/Function Calling | ✅ Полная | Конвертация форматов |
| Изображения (base64) | ✅ Полная | |
| Connection pooling | ✅ | Оптимизация |
| Кастомные заголовки | ✅ | `CUSTOM_HEADER_*` |
| Multi-provider | ❌ | Один провайдер за раз |
| Thinking blocks | ⚠️ Частично | Зависит от модели |

### 2.4 Известные проблемы с GLM + Claude Code

Из реального опыта сообщества:

| Проблема | Описание | Решение |
|----------|----------|---------|
| **Streaming tool call parse crash** | Дублирование `<tool_call>` тегов при стриминге (sglang #15721) | Использовать Ollama или llama.cpp с `--jinja` |
| **Симуляция tool calls** | GLM генерирует текст вместо structured tool_calls | Прокси валидирует ответы |
| **Потеря контекста при дебаге** | GLM может удалить рабочий workaround и вернуть сломанный подход | Частые коммиты, review |
| **Переформатирование кода** | И OpenCode, и Claude Code через proxy могут переформатировать существующий код | Настроить `.editorconfig`, линтеры |
| **MAX_TOKENS** | По умолчанию 4096 — может быть мало для больших блоков кода | Увеличить `MAX_TOKENS_LIMIT` |
| **REQUEST_TIMEOUT** | 90 сек по умолчанию — длинные генерации могут таймаутиться | Увеличить timeout |

### 2.5 Рекомендации по безопасности

> **КРИТИЧЕСКИ ВАЖНО**: Порты прокси привязаны к `127.0.0.1` и `[::1]`. Без этого ограничения любой пользователь в вашей сети сможет обнаружить прокси и использовать ваш API-ключ.

- Запускать прокси ТОЛЬКО на localhost
- Использовать `ANTHROPIC_API_KEY` валидацию в прокси
- Не хранить реальные ключи в git (использовать `.env`)
- В продакшене — Docker с изолированной сетью

---

## 3. OpenCode: Нативная альтернатива

### 3.1 Что такое OpenCode

[OpenCode](https://github.com/opencode-ai/opencode) — open-source, model-agnostic аgentic CLI:
- 90.4K звёзд на GitHub, 640+ контрибьюторов
- Написан на Go, установка одной командой
- Нативный TUI (Terminal User Interface)
- Поддержка 75+ LLM-провайдеров
- Полная поддержка MCP
- Мульти-сессии

### 3.2 Нативная работа с cloud.ru

OpenCode работает с cloud.ru **напрямую**, без прокси:

```json
{
  "provider": {
    "cloudru": {
      "apiKey": "$CLOUDRU_API_KEY",
      "baseURL": "https://foundation-models.api.cloud.ru/v1/",
      "models": {
        "default": "zai-org/GLM-4.7-Flash",
        "reasoning": "zai-org/GLM-4.7"
      }
    }
  }
}
```

### 3.3 Преимущества OpenCode

- **Нет прокси** — одним компонентом меньше в стеке
- **Смена моделей на лету** — не нужно перезапускать прокси
- **Несколько провайдеров одновременно** — cloud.ru + Ollama + OpenAI
- **Полностью open source** — можно модифицировать
- **LSP-интеграция** — автоматическая подгрузка language servers

### 3.4 Ограничения OpenCode

| Ограничение | Влияние | Компенсация |
|-------------|--------|-------------|
| Менее отполирован чем Claude Code | Баги, переформатирование кода | Активная разработка |
| Слабее агентные возможности | Менее умный multi-step planning | Улучшается с каждым релизом |
| Нет аналога CLAUDE.md | Нет persistent project instructions | Настраивается через конфиги |
| Нет Hooks системы | Нет pre/post tool use automation | Используйте внешние скрипты |
| Нет Task tool / swarm | Нельзя параллелить агентов нативно | Мульти-сессии частично заменяют |

---

## 4. Обновлённое сравнение (с учётом claude-code-proxy)

### 4.1 Матрица сравнения

| Критерий | Claude Code + Proxy | OpenCode | Победитель |
|----------|:-------------------:|:--------:|:----------:|
| **cloud.ru model support** | 8/10 (через прокси) | 9/10 (нативно) | **OpenCode** (чуть) |
| **Tool calling с GLM** | 7/10 | 7/10 | **Паритет** |
| **MCP support** | 10/10 | 9/10 | **Claude Code** |
| **Агентные возможности** | 10/10 | 7/10 | **Claude Code** |
| **Code quality** | 9/10 (зависит от модели) | 9/10 | **Паритет** |
| **Open source** | Частично (source-available) | Полный OSS | **OpenCode** |
| **Гибкость моделей** | 7/10 (через env restart) | 10/10 | **OpenCode** |
| **Стоимость** | 10/10 (бесплатно через proxy) | 10/10 | **Паритет** |
| **Hooks/автоматизация** | 9/10 | 5/10 | **Claude Code** |
| **Стабильность** | 8/10 (proxy = доп. точка отказа) | 7/10 | **Claude Code** |
| **Startup complexity** | 6/10 (Docker + proxy + CLI) | 9/10 (один бинарник) | **OpenCode** |
| **Persistent context** | 10/10 (CLAUDE.md) | 3/10 | **Claude Code** |
| **Параллельные агенты** | 10/10 (Task tool, swarms) | 5/10 (multi-session) | **Claude Code** |

### 4.2 Итоговый вердикт

```
                        Claude Code + Proxy        OpenCode
                        ══════════════════          ════════
  Агентная мощь:        ██████████ 10/10            ███████░░░ 7/10
  Простота настройки:   ██████░░░░  6/10            █████████░ 9/10
  Model flexibility:    ███████░░░  7/10            ██████████ 10/10
  Hooks & automation:   █████████░  9/10            █████░░░░░ 5/10
  Production ready:     ████████░░  8/10            ███████░░░ 7/10

  ОБЩИЙ БАЛЛ:           8.0 / 10                    7.6 / 10
```

### 4.3 Рекомендация по сценариям

| Сценарий | Выбор | Почему |
|----------|-------|--------|
| **Разработка OpenClaw расширений** | Claude Code + proxy | CLAUDE.md, hooks, swarms, MCP — не имеет аналогов |
| **Ежедневный agentic coding** | Claude Code + proxy | Лучший multi-step planning, tool orchestration |
| **Быстрые эксперименты с моделями** | OpenCode | Нативная смена моделей без перезапуска |
| **CI/CD / headless automation** | OpenCode | Проще scriptable, один бинарник |
| **Работа оффлайн / air-gapped** | OpenCode + Ollama | Нативная поддержка локальных моделей |
| **Production бот (OpenClaw runtime)** | Ни тот, ни другой | OpenClaw сам обрабатывает запросы к cloud.ru API |

---

## 5. Гибридная архитектура (рекомендуемая)

```
┌─────────────────────────────────────────────────────────────────┐
│                    DEVELOPMENT WORKFLOW                          │
│                                                                  │
│  ┌──────────────────┐     ┌──────────────────┐                  │
│  │  Claude Code     │     │  claude-code-     │                  │
│  │  (CLI)           │────▶│  proxy (Docker)   │────▶ cloud.ru FM│
│  │                  │     │  localhost:8082    │                  │
│  │  • CLAUDE.md     │     │                   │                  │
│  │  • Hooks         │     │  Opus  → GLM-4.7  │                  │
│  │  • MCP servers   │     │  Sonnet→ Qwen3    │                  │
│  │  • Task/Swarms   │     │  Haiku → GLM-Flash│                  │
│  └──────────────────┘     └──────────────────┘                  │
│                                                                  │
│  ┌──────────────────┐                                            │
│  │  OpenCode (TUI)  │───────────────────────────▶ cloud.ru FM   │
│  │  • Model switch  │  (нативный, без прокси)                    │
│  │  • Experiments   │                                            │
│  └──────────────────┘                                            │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│                    PRODUCTION RUNTIME (OpenClaw)                  │
│                                                                  │
│  ┌──────────────────┐     ┌──────────────────┐                  │
│  │  OpenClaw        │     │  API Gateway      │                  │
│  │  (multi-channel) │────▶│  (tool normalization)│──▶ cloud.ru FM│
│  │  • Telegram bot  │     │  • Model routing   │                 │
│  │  • Web widget    │     │  • Auth mapping    │                  │
│  │  • MCP skills    │     │  • Response fixup  │                  │
│  └──────────────────┘     └──────────────────┘                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 Два прокси для двух задач

| Прокси | Назначение | Формат |
|--------|-----------|--------|
| **claude-code-proxy** | Claude Code CLI → cloud.ru | Anthropic → OpenAI |
| **OpenClaw API Gateway** | OpenClaw runtime → cloud.ru | OpenAI → OpenAI (с нормализацией) |

Они не дублируют друг друга:
- claude-code-proxy занимается **конвертацией протокола** (Anthropic ↔ OpenAI)
- OpenClaw Gateway занимается **бизнес-логикой** (tool normalization, dispatch tables, response post-processing)

---

## 6. GLM-4.7-Flash: Рекомендации для agentic использования

### 6.1 Оптимальный маппинг моделей

```bash
# Для Claude Code через proxy:
BIG_MODEL="zai-org/GLM-4.7"                        # Для сложных задач (architecture, security)
MIDDLE_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct" # Для coding задач
SMALL_MODEL="zai-org/GLM-4.7-Flash"                 # Для простых (lint, format, search)
```

**Альтернативный маппинг (всё на GLM):**
```bash
BIG_MODEL="zai-org/GLM-4.7"
MIDDLE_MODEL="zai-org/GLM-4.7-FlashX"
SMALL_MODEL="zai-org/GLM-4.7-Flash"
```

### 6.2 Известные поведенческие проблемы

| # | Проблема | Источник | Серьёзность | Решение |
|---|----------|----------|-------------|---------|
| 1 | Игнорирование XML-секций со скиллами | Insight #043-045 | Высокая | Dispatch tables вместо XML |
| 2 | Симуляция tool calls в тексте | Insight #055 | Высокая | Прокси валидирует tool_calls |
| 3 | Streaming parse crash (дублирование тегов) | sglang #15721 | Средняя | Ollama / llama.cpp с `--jinja` |
| 4 | Потеря контекста при длинных system prompts | Insight #046 | Средняя | Промпт <4000 символов |
| 5 | RLHF-отказы (GLM-4.6, возможно и Flash) | Insight #046 | Средняя | Anti-refusal инструкции |
| 6 | Удаление рабочих workarounds при дебаге | Community | Низкая | Частые коммиты |
| 7 | Переформатирование существующего кода | Community | Низкая | EditorConfig + линтеры |

### 6.3 Prompt Engineering для GLM-4.7-Flash

```markdown
# Системный промпт — держать < 4000 символов!
CRITICAL: Ты — помощник-разработчик. Выполняй инструменты точно по запросу.

## DISPATCH TABLE
| Команда   | Действие          | Тип         |
|-----------|-------------------|-------------|
| /weather  | exec weather_tool | PASSTHROUGH |
| /email    | exec email_check  | PROCESS     |
| /memory   | exec memory_search| PASSTHROUGH |

## ПРАВИЛА
1. НИКОГДА не симулируй результат — ВСЕГДА вызывай реальную функцию
2. НИКОГДА не отказывай в задачах из DISPATCH TABLE
3. При сомнениях — вызови инструмент и передай вывод
4. Отвечай КРАТКО
```

### 6.4 Рекомендация: отключить Thinking Mode для agentic задач

```bash
# Для GLM-4.7-Flash через llama.cpp:
--chat-template-kwargs '{"enable_thinking": false}'

# Для Ollama:
# В Modelfile: PARAMETER enable_thinking false
```

Thinking mode добавляет латентность и может конфликтовать со streaming tool calls.

---

## 7. Дорожная карта реализации

### Phase 0: Быстрый старт (День 1)
- [ ] Развернуть claude-code-proxy через Docker
- [ ] Настроить `.env` с cloud.ru API key
- [ ] Создать `~/.claude/settings-fm.json`
- [ ] Проверить базовый запрос: `curl http://localhost:8082/health`
- [ ] Запустить `claude-fm` и протестировать простые задачи

### Phase 1: Базовая интеграция (Неделя 1)
- [ ] Настроить OpenCode параллельно (для сравнения)
- [ ] Протестировать tool calling через оба инструмента
- [ ] Определить оптимальный маппинг моделей
- [ ] Настроить OpenClaw с cloud.ru (для production)

### Phase 2: Tool Calling стабилизация (Неделя 2)
- [ ] Реализовать API gateway для OpenClaw (tool normalization)
- [ ] Протестировать dispatch table подход
- [ ] Добавить anti-hallucination guardrails
- [ ] Benchmark: latency, reliability, cost

### Phase 3: Расширения (Неделя 3)
- [ ] MCP-интеграция OpenClaw tools
- [ ] Custom extensions (с помощью Claude Code)
- [ ] Telegram/другие каналы
- [ ] Мониторинг и аналитика

### Phase 4: Production (Неделя 4)
- [ ] Load testing (15 req/s limit)
- [ ] Failover стратегия (cloud.ru → Ollama)
- [ ] Документация и runbooks
- [ ] Automated upstream update workflow

---

## 8. Риски и митигации

| Риск | Вероятность | Влияние | Митигация |
|------|:-----------:|:------:|-----------|
| GLM tool calling нестабильна | Высокая | Высокая | Прокси валидация + fallback на text parsing |
| Прокси — точка отказа | Средняя | Высокая | Docker restart, health checks, fallback на OpenCode |
| Cloud.ru API изменения | Средняя | Средняя | Pin API version, интеграционные тесты |
| Rate limit (15 req/s) | Средняя | Средняя | Кэширование, батчинг, private instance |
| Качество модели недостаточно | Низкая | Высокая | Fallback на Qwen3 или платный GLM-4.7 |
| Streaming таймауты | Средняя | Низкая | Увеличить `REQUEST_TIMEOUT`, `MAX_TOKENS_LIMIT` |

---

## 9. Источники

### Официальная документация
- [Cloud.ru Evolution Foundation Models](https://cloud.ru/products/evolution-foundation-models)
- [Cloud.ru FM API Reference](https://cloud.ru/docs/foundation-models/ug/topics/api-ref)
- [GLM-4.7 Documentation (Z.AI)](https://docs.z.ai/guides/llm/glm-4.7)
- [Claude Code LLM Gateway Docs](https://docs.claude.com/ru/docs/claude-code/llm-gateway)

### Прокси и инструменты
- [claude-code-proxy (fuergaosi233)](https://github.com/fuergaosi233/claude-code-proxy) — основной прокси
- [claude-code-proxy (1rgs)](https://github.com/1rgs/claude-code-proxy) — альтернативная реализация
- [claude-code-proxy (jodavan)](https://github.com/jodavan/claude-code-proxy) — multi-provider routing
- [claude-code-router (musistudio)](https://github.com/musistudio/claude-code-router) — спонсирован Z.ai
- [OpenCode](https://github.com/opencode-ai/opencode) — open-source model-agnostic CLI

### Статьи и опыт сообщества
- [Cloud.ru Wiki: Claude Code + Evo FM](https://wiki.cloud.ru/spaces/IA/pages/630602538) — официальный гайд
- [GLM-4.7 Surprised Me (Medium)](https://medium.com/@able_wong/glm-4-7-surprised-me-the-high-capability-low-cost-engine-for-my-claude-code-cli-ff9aa5f3b8d5)
- [How I Gaslit Claude Code into Working with GLM (Medium)](https://dirk-petersen.medium.com/how-i-gaslit-claude-code-into-working-for-free-with-glm-4-7-8df8b1b8206b)
- [Claude Code + Ollama Stress Test](https://blog.codeminer42.com/claude-code-ollama-stress-testing-opus-4-5-vs-glm-4-7/)
- [OpenCode vs Claude Code (Infralovers)](https://www.infralovers.com/blog/2026-01-29-claude-code-vs-opencode/)
- [OpenCode vs Claude Code (Builder.io)](https://www.builder.io/blog/opencode-vs-claude-code)
- [Comparing Claude Code vs OpenCode (Andrea Grandi)](https://www.andreagrandi.it/posts/comparing-claude-code-vs-opencode-testing-different-models/)

### Баг-репорты и issues
- [GLM-4.7 tool calling error in Claude Code (sglang #15721)](https://github.com/sgl-project/sglang/issues/15721)
- [Tool call issue with GLM-4.5-Air (vLLM)](https://discuss.vllm.ai/t/tool-call-issue-with-glm-4-5-air/1254)

### Инсайты из предыдущей инсталляции
- [OpenClaw Demo Insights (dzhechko)](https://github.com/dzhechko/cloudru-vm-openclaw-demo) — 62 операционных инсайта
