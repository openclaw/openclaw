---
summary: "Как работает память OpenClaw (файлы рабочего пространства + автоматический сброс памяти)"
read_when:
  - Вам нужна схема файлов памяти и рабочий процесс
  - Вы хотите настроить автоматический предварительный сброс памяти перед уплотнением
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:56:15Z
---

# Память

Память OpenClaw — это **обычный Markdown в рабочем пространстве агента**. Файлы являются
источником истины; модель «помнит» только то, что записано на диск.

Инструменты поиска по памяти предоставляются активным плагином памяти (по умолчанию:
`memory-core`). Отключить плагины памяти можно с помощью `plugins.slots.memory = "none"`.

## Файлы памяти (Markdown)

Макет рабочего пространства по умолчанию использует два уровня памяти:

- `memory/YYYY-MM-DD.md`
  - Ежедневный журнал (только добавление).
  - Читается сегодняшний и вчерашний день при старте сеанса.
- `MEMORY.md` (необязательно)
  - Кураторская долгосрочная память.
  - **Загружается только в основном, приватном сеансе** (никогда в групповых контекстах).

Эти файлы находятся в рабочем пространстве (`agents.defaults.workspace`, по умолчанию
`~/.openclaw/workspace`). Полную структуру см. в разделе [Agent workspace](/concepts/agent-workspace).

## Когда записывать в память

- Решения, предпочтения и устойчивые факты записывайте в `MEMORY.md`.
- Повседневные заметки и текущий контекст — в `memory/YYYY-MM-DD.md`.
- Если кто-то говорит «запомни это», запишите это (не храните в RAM).
- Этот раздел всё ещё развивается. Полезно напоминать модели сохранять воспоминания; она знает, что делать.
- Если вы хотите, чтобы что-то сохранилось, **попросите бота записать это** в память.

## Автоматический сброс памяти (предварительный пинг перед уплотнением)

Когда сеанс **приближается к авто-уплотнению**, OpenClaw запускает **тихий,
агентный ход**, который напоминает модели записать устойчивую память **до**
уплотнения контекста. В подсказках по умолчанию прямо сказано, что модель _может ответить_,
но обычно правильным ответом является `NO_REPLY`, чтобы пользователь не видел этот ход.

Это управляется через `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Подробности:

- **Мягкий порог**: сброс срабатывает, когда оценка токенов сеанса превышает
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Тихо** по умолчанию: подсказки включают `NO_REPLY`, поэтому ничего не доставляется.
- **Две подсказки**: пользовательская и системная подсказки добавляют напоминание.
- **Один сброс за цикл уплотнения** (отслеживается в `sessions.json`).
- **Рабочее пространство должно быть доступно для записи**: если сеанс выполняется в sandbox с
  `workspaceAccess: "ro"` или `"none"`, сброс пропускается.

Полный жизненный цикл уплотнения см. в разделе
[Session management + compaction](/reference/session-management-compaction).

## Векторный поиск по памяти

OpenClaw может построить небольшой векторный индекс поверх `MEMORY.md` и `memory/*.md`, чтобы
семантические запросы находили связанные заметки даже при различной формулировке.

Значения по умолчанию:

- Включено по умолчанию.
- Отслеживает изменения файлов памяти (с debounce).
- По умолчанию использует удалённые эмбеддинги. Если `memorySearch.provider` не задан, OpenClaw автоматически выбирает:
  1. `local`, если настроен `memorySearch.local.modelPath` и файл существует.
  2. `openai`, если удаётся определить ключ OpenAI.
  3. `gemini`, если удаётся определить ключ Gemini.
  4. `voyage`, если удаётся определить ключ Voyage.
  5. В противном случае поиск по памяти остаётся отключённым до настройки.
- Локальный режим использует node-llama-cpp и может требовать `pnpm approve-builds`.
- Использует sqlite-vec (когда доступен) для ускорения векторного поиска внутри SQLite.

Удалённые эмбеддинги **требуют** ключ API для провайдера эмбеддингов. OpenClaw
разрешает ключи из профилей аутентификации, `models.providers.*.apiKey` или переменных
окружения. Codex OAuth покрывает только chat/completions и **не** подходит для
эмбеддингов поиска по памяти. Для Gemini используйте `GEMINI_API_KEY` или
`models.providers.google.apiKey`. Для Voyage используйте `VOYAGE_API_KEY` или
`models.providers.voyage.apiKey`. При использовании пользовательского OpenAI-совместимого эндпоинта
задайте `memorySearch.remote.apiKey` (и необязательно `memorySearch.remote.headers`).

### Бэкенд QMD (экспериментально)

Установите `memory.backend = "qmd"`, чтобы заменить встроенный индексатор SQLite на
[QMD](https://github.com/tobi/qmd): локальный поисковый сайдкар, объединяющий
BM25 + векторы + переранжирование. Markdown остаётся источником истины; OpenClaw
вызывает QMD для извлечения. Ключевые моменты:

**Предварительные требования**

- По умолчанию отключено. Включение — на уровне конфига (`memory.backend = "qmd"`).
- Установите CLI QMD отдельно (`bun install -g https://github.com/tobi/qmd` или скачайте
  релиз) и убедитесь, что бинарник `qmd` находится в `PATH` шлюза.
- QMD требует сборку SQLite с поддержкой расширений (`brew install sqlite` на
  macOS).
- QMD полностью работает локально через Bun + `node-llama-cpp` и автоматически
  загружает модели GGUF с HuggingFace при первом использовании (отдельный демон Ollama не требуется).
- Gateway (шлюз) запускает QMD в изолированном XDG home под
  `~/.openclaw/agents/<agentId>/qmd/`, устанавливая `XDG_CONFIG_HOME` и
  `XDG_CACHE_HOME`.
- Поддержка ОС: macOS и Linux работают «из коробки» после установки Bun + SQLite.
  Windows лучше всего поддерживается через WSL2.

**Как работает сайдкар**

- Gateway (шлюз) создаёт самодостаточный QMD home под
  `~/.openclaw/agents/<agentId>/qmd/` (конфиг + кэш + sqlite DB).
- Коллекции создаются через `qmd collection add` из `memory.qmd.paths`
  (плюс файлы памяти рабочего пространства по умолчанию), затем `qmd update` + `qmd embed` выполняются
  при загрузке и с настраиваемым интервалом (`memory.qmd.update.interval`,
  по умолчанию 5 м).
- Обновление при загрузке теперь по умолчанию выполняется в фоне, чтобы запуск чата
  не блокировался; установите `memory.qmd.update.waitForBootSync = true`, чтобы сохранить прежнее
  блокирующее поведение.
- Поиск выполняется через `qmd query --json`. Если QMD падает или бинарник отсутствует,
  OpenClaw автоматически возвращается к встроенному менеджеру SQLite, чтобы инструменты
  памяти продолжали работать.
- OpenClaw сегодня не предоставляет настройку batch-size эмбеддингов QMD; пакетное
  поведение контролируется самим QMD.
- **Первый поиск может быть медленным**: QMD может загружать локальные модели GGUF
  (переранжирование/расширение запроса) при первом запуске `qmd query`.
  - OpenClaw автоматически устанавливает `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`, когда запускает QMD.
  - Если вы хотите предварительно загрузить модели вручную (и прогреть тот же индекс,
    который использует OpenClaw), выполните одноразовый запрос с XDG-директориями агента.

    Состояние QMD OpenClaw находится в вашем **каталоге состояния** (по умолчанию `~/.openclaw`).
    Вы можете направить `qmd` на точно такой же индекс, экспортировав те же XDG-переменные,
    которые использует OpenClaw:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Поверхность конфигурации (`memory.qmd.*`)**

- `command` (по умолчанию `qmd`): переопределить путь к исполняемому файлу.
- `includeDefaultMemory` (по умолчанию `true`): автоиндексация `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: добавить дополнительные каталоги/файлы (`path`, необязательно `pattern`, необязательно
  стабильный `name`).
- `sessions`: включить индексацию JSONL сеансов (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: управляет частотой обновления и выполнением обслуживания:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: ограничение полезной нагрузки recall (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: та же схема, что и [`session.sendPolicy`](/gateway/configuration#session).
  По умолчанию — только DMs (`deny` все, `allow` прямые чаты); ослабьте,
  чтобы показывать результаты QMD в группах/каналах.
- Фрагменты, полученные вне рабочего пространства, отображаются как
  `qmd/<collection>/<relative-path>` в результатах `memory_search`; `memory_get`
  понимает этот префикс и читает из настроенного корня коллекции QMD.
- Когда `memory.qmd.sessions.enabled = true`, OpenClaw экспортирует очищенные транскрипты
  сеансов (ходы User/Assistant) в отдельную коллекцию QMD под
  `~/.openclaw/agents/<id>/qmd/sessions/`, чтобы `memory_search` мог
  вспоминать недавние разговоры, не затрагивая встроенный индекс SQLite.
- Фрагменты `memory_search` теперь включают подвал `Source: <path#line>`, когда
  `memory.citations` равно `auto`/`on`; установите `memory.citations = "off"`,
  чтобы оставить метаданные пути внутренними (агент всё равно получает путь для
  `memory_get`, но текст фрагмента опускает подвал, а системная подсказка
  предупреждает агента не цитировать его).

**Пример**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Цитирование и fallback**

- `memory.citations` применяется независимо от бэкенда (`auto`/`on`/`off`).
- Когда выполняется `qmd`, мы помечаем `status().backend = "qmd"`, чтобы диагностика
  показывала, какой движок выдал результаты. Если подпроцесс QMD завершается или
  JSON-вывод не удаётся разобрать, менеджер поиска пишет предупреждение и возвращает
  встроенного провайдера (существующие эмбеддинги Markdown), пока QMD не восстановится.

### Дополнительные пути памяти

Если вы хотите индексировать Markdown-файлы вне макета рабочего пространства по умолчанию,
добавьте явные пути:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Примечания:

- Пути могут быть абсолютными или относительными к рабочему пространству.
- Каталоги сканируются рекурсивно на наличие файлов `.md`.
- Индексируются только Markdown-файлы.
- Символические ссылки игнорируются (файлы и каталоги).

### Эмбеддинги Gemini (нативно)

Установите провайдер `gemini`, чтобы использовать API эмбеддингов Gemini напрямую:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Примечания:

- `remote.baseUrl` необязателен (по умолчанию — базовый URL API Gemini).
- `remote.headers` позволяет добавлять дополнительные заголовки при необходимости.
- Модель по умолчанию: `gemini-embedding-001`.

Если вы хотите использовать **пользовательский OpenAI-совместимый эндпоинт** (OpenRouter, vLLM или прокси),
можно использовать конфигурацию `remote` с провайдером OpenAI:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Если вы не хотите задавать ключ API, используйте `memorySearch.provider = "local"` или установите
`memorySearch.fallback = "none"`.

Fallback’и:

- `memorySearch.fallback` может быть `openai`, `gemini`, `local` или `none`.
- Провайдер fallback используется только когда основной провайдер эмбеддингов не срабатывает.

Пакетная индексация (OpenAI + Gemini):

- Включена по умолчанию для эмбеддингов OpenAI и Gemini. Установите `agents.defaults.memorySearch.remote.batch.enabled = false`, чтобы отключить.
- Поведение по умолчанию ждёт завершения пакета; при необходимости настройте `remote.batch.wait`, `remote.batch.pollIntervalMs` и `remote.batch.timeoutMinutes`.
- Установите `remote.batch.concurrency` для управления числом параллельно отправляемых batch-задач (по умолчанию: 2).
- Пакетный режим применяется, когда `memorySearch.provider = "openai"` или `"gemini"`, и использует соответствующий ключ API.
- Пакетные задания Gemini используют асинхронный batch-эндпоинт эмбеддингов и требуют доступности Gemini Batch API.

Почему batch OpenAI быстрый и дешёвый:

- Для крупных обратных заполнений OpenAI обычно самый быстрый поддерживаемый вариант, потому что мы можем отправлять множество запросов эмбеддингов в одном batch-задании и позволить OpenAI обрабатывать их асинхронно.
- OpenAI предлагает скидки для нагрузок Batch API, поэтому крупные прогоны индексации обычно дешевле, чем отправка тех же запросов синхронно.
- Подробности см. в документации и ценах OpenAI Batch API:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Пример конфига:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Инструменты:

- `memory_search` — возвращает фрагменты с файлом и диапазонами строк.
- `memory_get` — читает содержимое файла памяти по пути.

Локальный режим:

- Установите `agents.defaults.memorySearch.provider = "local"`.
- Укажите `agents.defaults.memorySearch.local.modelPath` (GGUF или URI `hf:`).
- Необязательно: установите `agents.defaults.memorySearch.fallback = "none"`, чтобы избежать удалённого fallback.

### Как работают инструменты памяти

- `memory_search` выполняет семантический поиск по Markdown-фрагментам (целевой размер ~400 токенов, перекрытие 80 токенов) из `MEMORY.md` + `memory/**/*.md`. Он возвращает текст фрагмента (ограничение ~700 символов), путь к файлу, диапазон строк, оценку, провайдера/модель и факт fallback’а с локальных → удалённые эмбеддинги. Полные файлы не возвращаются.
- `memory_get` читает конкретный Markdown-файл памяти (относительно рабочего пространства), при необходимости начиная с указанной строки и на N строк. Пути вне `MEMORY.md` / `memory/` отклоняются.
- Оба инструмента включены только когда `memorySearch.enabled` вычисляется как true для агента.

### Что индексируется (и когда)

- Тип файла: только Markdown (`MEMORY.md`, `memory/**/*.md`).
- Хранилище индекса: SQLite для каждого агента в `~/.openclaw/memory/<agentId>.sqlite` (настраивается через `agents.defaults.memorySearch.store.path`, поддерживает токен `{agentId}`).
- Актуальность: наблюдатель за `MEMORY.md` + `memory/` помечает индекс «грязным» (debounce 1,5 с). Синхронизация планируется при старте сеанса, при поиске или по интервалу и выполняется асинхронно. Транскрипты сеансов используют пороги дельты для запуска фоновой синхронизации.
- Триггеры переиндексации: индекс хранит **провайдера/модель эмбеддингов + отпечаток эндпоинта + параметры чанкинга**. При изменении любого из них OpenClaw автоматически сбрасывает и переиндексирует всё хранилище.

### Гибридный поиск (BM25 + вектор)

Когда включён, OpenClaw объединяет:

- **Векторное сходство** (семантическое совпадение, формулировки могут отличаться)
- **Ключевую релевантность BM25** (точные токены, такие как ID, переменные окружения, символы кода)

Если полнотекстовый поиск недоступен на вашей платформе, OpenClaw переходит на поиск только по векторам.

#### Зачем гибрид?

Векторный поиск отлично справляется с «это означает то же самое»:

- «Mac Studio gateway host» vs «the machine running the gateway»
- «debounce file updates» vs «avoid indexing on every write»

Но он может быть слаб в точных, высокосигнальных токенах:

- ID (`a828e60`, `b3b9895a…`)
- символы кода (`memorySearch.query.hybrid`)
- строки ошибок («sqlite-vec unavailable»)

BM25 (полнотекст) — наоборот: силён в точных токенах, слабее в перефразировании.
Гибридный поиск — прагматичный компромисс: **использовать оба сигнала извлечения**,
чтобы получать хорошие результаты как для «естественного языка», так и для запросов
типа «иголка в стоге сена».

#### Как мы объединяем результаты (текущий дизайн)

Набросок реализации:

1. Получаем пул кандидатов с обеих сторон:

- **Вектор**: top `maxResults * candidateMultiplier` по косинусному сходству.
- **BM25**: top `maxResults * candidateMultiplier` по рангу FTS5 BM25 (меньше — лучше).

2. Преобразуем ранг BM25 в оценку примерно 0..1:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Объединяем кандидатов по id чанка и считаем взвешенную оценку:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Примечания:

- `vectorWeight` + `textWeight` нормализуются до 1.0 при разрешении конфига, поэтому веса ведут себя как проценты.
- Если эмбеддинги недоступны (или провайдер возвращает нулевой вектор), мы всё равно выполняем BM25 и возвращаем совпадения по ключевым словам.
- Если FTS5 не удаётся создать, мы сохраняем поиск только по векторам (без жёсткого сбоя).

Это не «идеально по теории ИР», но просто, быстро и обычно улучшает полноту/точность на реальных заметках.
Если позже захочется усложнить, типичные следующие шаги — Reciprocal Rank Fusion (RRF) или нормализация оценок
(min/max или z-score) перед смешиванием.

Конфиг:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Кэш эмбеддингов

OpenClaw может кэшировать **эмбеддинги чанков** в SQLite, чтобы переиндексация и частые обновления
(особенно транскрипты сеансов) не переэмбеддили неизменённый текст.

Конфиг:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Поиск по памяти сеанса (экспериментально)

При желании можно индексировать **транскрипты сеансов** и показывать их через `memory_search`.
Это скрыто за экспериментальным флагом.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Примечания:

- Индексация сеансов — **opt-in** (по умолчанию выключено).
- Обновления сеансов дебаунсятся и **индексируются асинхронно** после превышения порогов дельты (best-effort).
- `memory_search` никогда не блокируется на индексации; результаты могут быть слегка устаревшими, пока не завершится фоновая синхронизация.
- Результаты по-прежнему содержат только фрагменты; `memory_get` остаётся ограниченным файлами памяти.
- Индексация сеансов изолирована на агента (индексируются только логи сеансов этого агента).
- Логи сеансов хранятся на диске (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Любой процесс/пользователь с доступом к файловой системе может их читать, поэтому границей доверия является доступ к диску. Для более строгой изоляции запускайте агентов под разными пользователями ОС или на разных хостах.

Пороги дельты (показаны значения по умолчанию):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### Ускорение векторов SQLite (sqlite-vec)

Когда доступно расширение sqlite-vec, OpenClaw хранит эмбеддинги в
виртуальной таблице SQLite (`vec0`) и выполняет запросы расстояния векторов
в базе данных. Это сохраняет высокую скорость поиска без загрузки всех эмбеддингов в JS.

Конфигурация (необязательно):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Примечания:

- `enabled` по умолчанию true; при отключении поиск возвращается к вычислению
  косинусного сходства в процессе по сохранённым эмбеддингам.
- Если расширение sqlite-vec отсутствует или не загружается, OpenClaw логирует
  ошибку и продолжает с JS-fallback’ом (без векторной таблицы).
- `extensionPath` переопределяет путь к встроенному sqlite-vec (полезно для кастомных сборок
  или нестандартных мест установки).

### Автозагрузка локальных эмбеддингов

- Локальная модель эмбеддингов по умолчанию: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 ГБ).
- Когда `memorySearch.provider = "local"`, `node-llama-cpp` разрешается в `modelPath`; если GGUF отсутствует, он **автоматически загружается** в кэш (или `local.modelCacheDir`, если задан), затем загружается в память. Загрузки возобновляются при повторе.
- Требование нативной сборки: выполните `pnpm approve-builds`, выберите `node-llama-cpp`, затем `pnpm rebuild node-llama-cpp`.
- Fallback: если локальная настройка не удалась и `memorySearch.fallback = "openai"`, мы автоматически переключаемся на удалённые эмбеддинги (`openai/text-embedding-3-small`, если не переопределено) и фиксируем причину.

### Пример пользовательского OpenAI-совместимого эндпоинта

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Примечания:

- `remote.*` имеет приоритет над `models.providers.openai.*`.
- `remote.headers` объединяются с заголовками OpenAI; при конфликте ключей побеждают удалённые. Уберите `remote.headers`, чтобы использовать значения OpenAI по умолчанию.
