---
summary: "Набор для тестирования: наборы unit/e2e/live, Docker-раннеры и то, что покрывает каждый тест"
read_when:
  - Запуск тестов локально или в CI
  - Добавление регрессий для багов моделей/провайдеров
  - Отладка поведения шлюза Gateway + агента
title: "Тестирование"
---

# Тестирование

В OpenClaw есть три набора Vitest (unit/integration, e2e, live) и небольшой набор Docker-раннеров.

Этот документ — руководство «как мы тестируем»:

- Что покрывает каждый набор (и что он намеренно _не_ покрывает)
- Какие команды запускать для типичных рабочих процессов (локально, перед push, отладка)
- Как live‑тесты находят учётные данные и выбирают модели/провайдеров
- Как добавлять регрессии для реальных проблем моделей/провайдеров

## Быстрый старт

В большинстве случаев:

- Полный gate (ожидается перед push): `pnpm build && pnpm check && pnpm test`

Когда вы правите тесты или хотите большей уверенности:

- Gate покрытия: `pnpm test:coverage`
- Набор E2E: `pnpm test:e2e`

При отладке реальных провайдеров/моделей (нужны реальные креды):

- Live‑набор (модели + проверки инструментов/изображений шлюза Gateway): `pnpm test:live`

Совет: когда нужен только один падающий кейс, лучше сузить live‑тесты с помощью allowlist‑переменных окружения, описанных ниже.

## Наборы тестов (что где запускается)

Думайте о наборах как об «увеличении реализма» (и увеличении флак‑ности/стоимости):

### Unit / integration (по умолчанию)

- Команда: `pnpm test`
- Конфиг: `vitest.config.ts`
- Файлы: `src/**/*.test.ts`
- Область:
  - Чистые unit‑тесты
  - Интеграционные тесты в одном процессе (аутентификация шлюза Gateway, маршрутизация, инструменты, парсинг, конфиг)
  - Детерминированные регрессии для известных багов
- Ожидания:
  - Запускается в CI
  - Реальные ключи не требуются
  - Должно быть быстро и стабильно

### E2E (smoke шлюза Gateway)

- Команда: `pnpm test:e2e`
- Конфиг: `vitest.e2e.config.ts`
- Файлы: `src/**/*.e2e.test.ts`
- Область:
  - End‑to‑end поведение шлюза Gateway с несколькими инстансами
  - Поверхности WebSocket/HTTP, сопряжение узлов и более тяжёлый сетевой слой
- Ожидания:
  - Запускается в CI (когда включено в пайплайне)
  - Реальные ключи не требуются
  - Больше движущихся частей, чем в unit‑тестах (может быть медленнее)

### Live (реальные провайдеры + реальные модели)

- Команда: `pnpm test:live`
- Конфиг: `vitest.live.config.ts`
- Файлы: `src/**/*.live.test.ts`
- По умолчанию: **включено** через `pnpm test:live` (устанавливает `OPENCLAW_LIVE_TEST=1`)
- Область:
  - «Работает ли этот провайдер/модель _сегодня_ с реальными кредами?»
  - Ловит изменения форматов провайдеров, особенности tool‑calling, проблемы аутентификации и поведение rate limit
- Ожидания:
  - По определению нестабильно для CI (реальные сети, реальные политики провайдеров, квоты, сбои)
  - Стоит денег / использует лимиты
  - Предпочтительно запускать узкие подмножества, а не «всё»
  - Live‑запуски будут читать `~/.profile`, чтобы подобрать недостающие API‑ключи
  - Ротация ключей Anthropic: задайте `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (или `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) либо несколько переменных `ANTHROPIC_API_KEY*`; тесты будут повторять попытки при rate limit

## Какой номер я должен работать?

Используйте эту таблицу решений:

- Правите логику/тесты: запускайте `pnpm test` (и `pnpm test:coverage`, если изменений много)
- Трогаете сетевое взаимодействие шлюза Gateway / WS‑протокол / сопряжение: добавьте `pnpm test:e2e`
- Отладка «мой бот не работает» / провайдер‑специфичные сбои / tool‑calling: запускайте суженный `pnpm test:live`

## Live: smoke моделей (ключи профилей)

Live‑тесты разделены на два слоя, чтобы изолировать сбои:

- «Прямая модель» показывает, что провайдер/модель вообще отвечает с данным ключом.
- «Smoke шлюза Gateway» показывает, что весь конвейер gateway+agent работает для этой модели (сеансы, история, инструменты, политика sandbox и т. д.).

### Слой 1: прямое завершение модели (без шлюза)

- Тест: `src/agents/models.profiles.live.test.ts`
- Цель:
  - Перечислить обнаруженные модели
  - Использовать `getApiKeyForModel` для выбора моделей, для которых есть креды
  - Запустить небольшое завершение для каждой модели (и целевые регрессии при необходимости)
- Как включить:
  - `pnpm test:live` (или `OPENCLAW_LIVE_TEST=1` при прямом запуске Vitest)
- Установите `OPENCLAW_LIVE_MODELS=modern` (или `all`, алиас для modern), чтобы реально запустить этот набор; иначе он пропускается, чтобы держать `pnpm test:live` сфокусированным на smoke шлюза Gateway
- Как выбрать модели:
  - `OPENCLAW_LIVE_MODELS=modern` для запуска modern allowlist (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` — алиас для modern allowlist
  - или `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)
- Как выбрать провайдеров:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Откуда берутся ключи:
  - По умолчанию: хранилище профилей и env‑fallback
  - Установите `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`, чтобы принудительно использовать **только хранилище профилей**
- Зачем это нужно:
  - Отделяет «API провайдера сломан / ключ недействителен» от «сломан конвейер агента шлюза Gateway»
  - Содержит небольшие, изолированные регрессии (пример: воспроизведение reasoning и потоки tool‑call в OpenAI Responses/Codex Responses)

### Слой 2: Gateway + dev‑агент smoke (то, что реально делает «@openclaw»)

- Тест: `src/gateway/gateway-models.profiles.live.test.ts`
- Цель:
  - Поднять шлюз Gateway в одном процессе
  - Создать/пропатчить сеанс `agent:dev:*` (переопределение модели на запуск)
  - Пройтись по моделям с ключами и проверить:
    - «осмысленный» ответ (без инструментов)
    - реальный вызов инструмента (probe чтения)
    - дополнительные probes инструментов (exec+read)
    - регрессионные пути OpenAI (только tool‑call → follow‑up) продолжают работать
- Детали probes (чтобы быстро объяснять сбои):
  - probe `read`: тест записывает файл‑nonce в рабочее пространство и просит агента `read` его и вернуть nonce.
  - probe `exec+read`: тест просит агента `exec`‑записать nonce во временный файл, затем `read` его.
  - image probe: тест прикрепляет сгенерированный PNG (кот + рандомный код) и ожидает, что модель вернёт `cat <CODE>`.
  - Ссылка на реализацию: `src/gateway/gateway-models.profiles.live.test.ts` и `src/gateway/live-image-probe.ts`.
- Как включить:
  - `pnpm test:live` (или `OPENCLAW_LIVE_TEST=1` при прямом запуске Vitest)
- Как выбрать модели:
  - По умолчанию: modern allowlist (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` — алиас для modern allowlist
  - Или установите `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (или список через запятую) для сужения
- Как выбрать провайдеров (избегайте «OpenRouter всё подряд»):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Probes инструментов и изображений всегда включены в этом live‑тесте:
  - probe `read` + probe `exec+read` (стресс инструментов)
  - image probe запускается, когда модель заявляет поддержку ввода изображений
  - Поток (высокий уровень):
    - Тест генерирует крошечный PNG с «CAT» + случайным кодом (`src/gateway/live-image-probe.ts`)
    - Отправляет его через `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Шлюз Gateway парсит вложения в `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Встроенный агент отправляет мультимодальное пользовательское сообщение модели
    - Проверка: ответ содержит `cat` + код (допускаются небольшие ошибки OCR)

Совет: чтобы увидеть, что можно тестировать на вашей машине (и точные id `provider/model`), выполните:

```bash
openclaw models list
openclaw models list --json
```

## Live: smoke setup‑token Anthropic

- Тест: `src/agents/anthropic.setup-token.live.test.ts`
- Цель: проверить, что setup‑token Claude Code CLI (или вставленный профиль setup‑token) может выполнить запрос Anthropic.
- Включение:
  - `pnpm test:live` (или `OPENCLAW_LIVE_TEST=1` при прямом запуске Vitest)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Источники токена (выберите один):
  - Профиль: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Сырой токен: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Переопределение модели (необязательно):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Пример настройки:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: smoke backend CLI (Claude Code CLI или другие локальные CLI)

- Тест: `src/gateway/gateway-cli-backend.live.test.ts`
- Цель: проверить конвейер Gateway + агент, используя локальный backend CLI, не затрагивая ваш конфиг по умолчанию.
- Включение:
  - `pnpm test:live` (или `OPENCLAW_LIVE_TEST=1` при прямом запуске Vitest)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Значения по умолчанию:
  - Модель: `claude-cli/claude-sonnet-4-5`
  - Команда: `claude`
  - Аргументы: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Переопределения (необязательно):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` для отправки реального изображения (пути внедряются в prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` для передачи путей к изображениям как аргументов CLI вместо внедрения в prompt.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (или `"list"`) для управления тем, как передаются аргументы изображений, когда задан `IMAGE_ARG`.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` для отправки второго шага и проверки потока возобновления.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` — оставить MCP‑конфиг Claude Code CLI включённым (по умолчанию MCP‑конфиг отключается временным пустым файлом).

Пример:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Рекомендуемые live‑рецепты

Узкие, явные allowlist‑ы — самые быстрые и наименее флак‑ные:

- Одна модель, напрямую (без шлюза):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Одна модель, smoke шлюза Gateway:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool‑calling у нескольких провайдеров:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Фокус на Google (ключ Gemini API + Antigravity):
  - Gemini (API‑ключ): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Примечания:

- `google/...` использует Gemini API (API‑ключ).
- `google-antigravity/...` использует OAuth‑мост Antigravity (endpoint агента в стиле Cloud Code Assist).
- `google-gemini-cli/...` использует локальный Gemini CLI на вашей машине (отдельная аутентификация + особенности инструментов).
- Gemini API vs Gemini CLI:
  - API: OpenClaw вызывает размещённый Google Gemini API по HTTP (API‑ключ / аутентификация профиля); именно это большинство пользователей подразумевает под «Gemini».
  - CLI: OpenClaw вызывает локальный бинарник `gemini`; у него своя аутентификация и возможны отличия в поведении (streaming/поддержка инструментов/расхождения версий).

## Live: матрица моделей (что мы покрываем)

Фиксированного «CI‑списка моделей» нет (live — opt‑in), но это **рекомендуемые** модели для регулярной проверки на машине разработчика с ключами.

### Modern smoke‑набор (tool‑calling + image)

Это «распространённые модели», которые мы ожидаем поддерживать в рабочем состоянии:

- OpenAI (не Codex): `openai/gpt-5.2` (необязательно: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (необязательно: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (или `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` и `google/gemini-3-flash-preview` (избегайте старых Gemini 2.x)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` и `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Запуск smoke шлюза Gateway с инструментами + изображением:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Базовый уровень: tool‑calling (Read + опционально Exec)

Выберите хотя бы одну модель из каждого семейства провайдеров:

- OpenAI: `openai/gpt-5.2` (или `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (или `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (или `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Дополнительное покрытие (по желанию):

- xAI: `xai/grok-4` (или последняя доступная)
- Mistral: `mistral/`… (выберите одну модель с поддержкой инструментов)
- Cerebras: `cerebras/`… (если есть доступ)
- LM Studio: `lmstudio/`… (локально; tool‑calling зависит от режима API)

### Vision: отправка изображения (вложение → мультимодальное сообщение)

Включите хотя бы одну модель с поддержкой изображений в `OPENCLAW_LIVE_GATEWAY_MODELS` (варианты Claude/Gemini/OpenAI с vision и т. п.), чтобы прогнать image probe. для упражнения изображения профиля.

### Агрегаторы / альтернативные шлюзы

Если у вас есть включённые ключи, мы также поддерживаем тестирование через:

- OpenRouter: `openrouter/...` (сотни моделей; используйте `openclaw models scan` для поиска кандидатов с tool+image)
- OpenCode Zen: `opencode/...` (аутентификация через `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Другие провайдеры, которые можно включить в live‑матрицу (при наличии кредов/конфига):

- Встроенные: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Через `models.providers` (кастомные endpoints): `minimax` (cloud/API), а также любой прокси, совместимый с OpenAI/Anthropic (LM Studio, vLLM, LiteLLM и т. п.)

Совет: не пытайтесь жёстко фиксировать «все модели» в документации. Авторитетный список — это то, что возвращает `discoverModels(...)` на вашей машине + доступные ключи.

## Учётные данные (никогда не коммитьте)

Live‑тесты находят креды так же, как и CLI. Практические следствия:

- Если CLI работает, live‑тесты должны найти те же ключи.

- Если live‑тест говорит «нет кредов», отлаживайте так же, как `openclaw models list` / выбор модели.

- Хранилище профилей: `~/.openclaw/credentials/` (предпочтительно; именно это имеется в виду под «profile keys» в тестах)

- Конфиг: `~/.openclaw/openclaw.json` (или `OPENCLAW_CONFIG_PATH`)

Если вы хотите полагаться на env‑ключи (например, экспортированные в вашем `~/.profile`), запускайте локальные тесты после `source ~/.profile` или используйте Docker‑раннеры ниже (они могут примонтировать `~/.profile` в контейнер).

## Deepgram live (аудио‑транскрипция)

- Тест: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Включение: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker‑раннеры (необязательные проверки «работает в Linux»)

Они запускают `pnpm test:live` внутри Docker‑образа репозитория, монтируя ваш локальный каталог конфига и рабочее пространство (и читая `~/.profile`, если примонтирован):

- Прямые модели: `pnpm test:docker:live-models` (скрипт: `scripts/test-live-models-docker.sh`)
- Gateway + dev‑агент: `pnpm test:docker:live-gateway` (скрипт: `scripts/test-live-gateway-models-docker.sh`)
- Мастер онбординга (TTY, полное развёртывание): `pnpm test:docker:onboard` (скрипт: `scripts/e2e/onboard-docker.sh`)
- Сетевое взаимодействие шлюза Gateway (два контейнера, WS‑аутентификация + health): `pnpm test:docker:gateway-network` (скрипт: `scripts/e2e/gateway-network-docker.sh`)
- Плагины (загрузка кастомных расширений + smoke реестра): `pnpm test:docker:plugins` (скрипт: `scripts/e2e/plugins-docker.sh`)

Полезные env вар:

- `OPENCLAW_CONFIG_DIR=...` (по умолчанию: `~/.openclaw`) монтируется в `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (по умолчанию: `~/.openclaw/workspace`) монтируется в `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (по умолчанию: `~/.profile`) монтируется в `/home/node/.profile` и читается перед запуском тестов
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` для сужения запуска
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` для гарантии, что креды берутся из хранилища профилей (а не из env)

## Снятие с документами

После правок документации запускайте проверки: `pnpm docs:list`.

## Оффлайн‑регрессии (безопасно для CI)

Это регрессии «реального конвейера» без реальных провайдеров:

- Tool‑calling шлюза Gateway (mock OpenAI, реальный цикл gateway + agent): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Мастер шлюза Gateway (WS `wizard.start`/`wizard.next`, запись конфига + принудительная аутентификация): `src/gateway/gateway.wizard.e2e.test.ts`

## Оценки надёжности агента (skills)

У нас уже есть несколько CI‑безопасных тестов, которые ведут себя как «оценки надёжности агента»:

- Mock tool‑calling через реальный цикл gateway + agent (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End‑to‑end потоки мастера, проверяющие проводку сеансов и эффекты конфига (`src/gateway/gateway.wizard.e2e.test.ts`).

Чего всё ещё не хватает для skills (см. [Skills](/tools/skills)):

- **Принятие решений:** когда skills перечислены в prompt, выбирает ли агент правильный skill (или избегает нерелевантных)?
- **Соблюдение требований:** читает ли агент `SKILL.md` перед использованием и следует ли обязательным шагам/аргументам?
- **Контракты рабочих процессов:** многошаговые сценарии, проверяющие порядок инструментов, перенос истории сеанса и границы sandbox.

Будущие eval‑ы должны сначала оставаться детерминированными:

- Раннер сценариев с mock‑провайдерами для проверки вызовов инструментов и их порядка, чтения файлов skills и проводки сеансов.
- Небольшой набор сценариев, сфокусированных на skills (использовать vs избегать, gating, prompt injection).
- Опциональные live‑eval‑ы (opt‑in, через env) — только после появления CI‑безопасного набора.

## Добавление регрессий (рекомендации)

Когда вы исправляете проблему провайдера/модели, обнаруженную в live:

- По возможности добавьте CI‑безопасную регрессию (mock/stub провайдера или захват точного преобразования формы запроса)
- Если это по своей природе только live (rate limit, политики аутентификации), держите live‑тест узким и opt‑in через env‑переменные
- Предпочитайте нацеливаться на самый нижний слой, который ловит баг:
  - баг конвертации/воспроизведения запроса провайдера → тест прямых моделей
  - баг конвейера сеансов/истории/инструментов шлюза Gateway → live smoke шлюза Gateway или CI‑безопасный mock‑тест шлюза
