# ClawHub Skills → Роли агентов: Полный маппинг

> Документ: анализ всех 20 ролей (15 бригадных + 5 автономных) и назначенные ClawHub-скилы.
> Дата: 2026-03-30

## Обзор

| Бригада | Ролей | Скилов назначено |
|---------|-------|------------------|
| Dmarket-Dev | 3 | 16 |
| OpenClaw-Core | 9 | 49 |
| Research-Ops | 3 | 15 |
| Автономные агенты | 5 | 24 |
| **Итого** | **20** | **104** |

---

## 🏭 Бригада: Dmarket-Dev

### Planner (Оркестратор)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Домен:** HFT-трейдинг, Dmarket API, арбитраж CS2 скинов

| Скил | Зачем |
|------|-------|
| `github` | Создание задач, PR, контроль репозитория |
| `gh-issues` | Автоматический трекинг задач и спавн sub-агентов |
| `trello` | Визуальное управление проектом / Kanban |
| `session-logs` | Анализ предыдущих сессий для контекста |
| `summarize` | Суммаризация отчётов для быстрого обзора |
| `clawhub` | Поиск и установка новых скилов |

### Coder (Разработчик)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Домен:** Python/asyncio, Dmarket API, WebSocket, HMAC

| Скил | Зачем |
|------|-------|
| `github` | Коммиты, PR, ревью кода |
| `coding-agent` | Делегирование сложных задач кодинга |
| `tmux` | Управление терминальными сессиями |
| `session-logs` | Контекст из предыдущих сессий |
| `clawhub` | Установка утилитных скилов по необходимости |
| `skill-creator` | Создание новых скилов для трейдинга |

### Auditor (Аудитор безопасности)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Домен:** Security audit, injection, credentials, risk

| Скил | Зачем |
|------|-------|
| `github` | Проверка коммитов на утечки |
| `healthcheck` | Сканирование системы на уязвимости |
| `session-logs` | Аудит логов сессий |
| `1password` | Безопасное управление секретами |
| `clawhub` | Проверка безопасности скилов |

---

## ⚙️ Бригада: OpenClaw-Core

### Planner (Оркестратор)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `gh-issues`, `trello`, `session-logs`, `summarize`, `clawhub`, `notion`

### Foreman (Прораб)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `tmux`, `session-logs`, `healthcheck`, `clawhub`

### Executor_Architect (Архитектор ядра)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `coding-agent`, `tmux`, `session-logs`, `clawhub`

### Executor_Tools (Инженер инструментов)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `coding-agent`, `tmux`, `skill-creator`, `mcporter`, `clawhub`, `session-logs`

### Executor_Integration (Интегратор)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `mcporter`, `tmux`, `session-logs`, `clawhub`, `healthcheck`

### Auditor (Безопасник)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `healthcheck`, `1password`, `session-logs`, `clawhub`

### Archivist (Архивист)
**Модель:** `arcee-ai/trinity-mini:free`
**Скилы:** `github`, `session-logs`, `summarize`, `obsidian`, `clawhub`

### State_Manager (Управление состоянием)
**Модель:** `arcee-ai/trinity-mini:free`
**Скилы:** `session-logs`, `summarize`, `clawhub`

### Test_Writer (Тестировщик)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `coding-agent`, `tmux`, `session-logs`, `clawhub`

---

## 🔬 Бригада: Research-Ops

### Researcher (Исследователь)
**Модель:** `arcee-ai/trinity-large-preview:free`
**Скилы:** `github`, `summarize`, `xurl`, `blogwatcher`, `session-logs`, `clawhub`, `nano-pdf`

### Analyst (Аналитик)
**Модель:** `nvidia/nemotron-3-super-120b-a12b:free`
**Скилы:** `github`, `session-logs`, `summarize`, `clawhub`

### Summarizer (Архивист)
**Модель:** `arcee-ai/trinity-mini:free`
**Скилы:** `summarize`, `session-logs`, `nano-pdf`, `clawhub`

---

## 🤖 Автономные агенты (openclaw_agents.json)

### Risk Manager
**Модель:** `deepseek/deepseek-r1:free`
**Скилы:** `github`, `session-logs`, `healthcheck`, `clawhub`

### Latency Monitor
**Модель:** `qwen/qwen-2.5-coder-32b-instruct:free`
**Скилы:** `github`, `coding-agent`, `tmux`, `session-logs`, `clawhub`

### Security Auditor
**Модель:** `google/gemma-3-12b-it:free`
**Скилы:** `github`, `healthcheck`, `1password`, `session-logs`, `clawhub`

### Tool Smith
**Модель:** `qwen/qwen-2.5-coder-32b-instruct:free`
**Скилы:** `github`, `coding-agent`, `skill-creator`, `mcporter`, `tmux`, `clawhub`, `session-logs`

### Memory Garbage Collector
**Модель:** `meta-llama/llama-3.3-70b-instruct:free`
**Скилы:** `session-logs`, `summarize`, `clawhub`

---

## 📊 Статистика использования скилов

| Скил | Ролей использует | Категория |
|------|------------------|-----------|
| `clawhub` | 20 | Маркетплейс |
| `session-logs` | 20 | Логирование |
| `github` | 17 | DevOps |
| `summarize` | 7 | Обработка текста |
| `coding-agent` | 6 | Разработка |
| `tmux` | 6 | Терминал |
| `healthcheck` | 5 | Безопасность |
| `1password` | 3 | Секреты |
| `skill-creator` | 3 | Создание скилов |
| `mcporter` | 3 | MCP инструменты |
| `gh-issues` | 2 | GitHub Issues |
| `trello` | 2 | PM/Kanban |
| `nano-pdf` | 2 | Документы |
| `obsidian` | 1 | Заметки |
| `notion` | 1 | PM |
| `xurl` | 1 | Twitter/X API |
| `blogwatcher` | 1 | RSS мониторинг |

## Скилы НЕ назначенные ролям (39 из 54)

Следующие скилы доступны, но не нужны текущим ролям:
`apple-notes`, `apple-reminders`, `bear-notes`, `blucli`, `bluebubbles`, `camsnap`, `canvas`, `discord`, `eightctl`, `gemini`, `gifgrep`, `gog`, `goplaces`, `himalaya`, `imsg`, `model-usage`, `nano-banana-pro`, `openai-image-gen`, `openai-whisper`, `openai-whisper-api`, `openhue`, `oracle`, `ordercli`, `peekaboo`, `sag`, `sherpa-onnx-tts`, `slack`, `songsee`, `sonoscli`, `spotify-player`, `template-skill`, `things-mac`, `video-frames`, `voice-call`, `wacli`, `weather`

Эти скилы могут быть назначены по запросу (например, `weather` для Research-Ops, `discord`/`slack` для коммуникационных ролей).
