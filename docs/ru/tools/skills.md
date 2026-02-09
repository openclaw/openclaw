---
summary: "Skills: управляемые vs рабочее пространство, правила гейтинга и подключение через конфиг/переменные окружения"
read_when:
  - Добавление или изменение skills
  - Изменение гейтинга skills или правил загрузки
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw использует папки skills, **совместимые с [AgentSkills](https://agentskills.io)**, чтобы обучать агента использованию инструментов. Каждый skill — это каталог, содержащий `SKILL.md` с YAML frontmatter и инструкциями. OpenClaw загружает **bundled skills**, а также необязательные локальные переопределения, и фильтрует их во время загрузки на основе окружения, конфига и наличия бинарников.

## Расположение и приоритеты

Skills загружаются из **трёх** мест:

1. **Bundled skills**: поставляются вместе с установкой (npm‑пакет или OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

При конфликте имён skills применяется следующий приоритет:

`<workspace>/skills` (наивысший) → `~/.openclaw/skills` → bundled skills (наинизший)

Кроме того, можно настроить дополнительные папки skills (наинизший приоритет) через
`skills.load.extraDirs` в `~/.openclaw/openclaw.json`.

## Skills для каждого агента и общие skills

В **многоагентных** конфигурациях у каждого агента есть собственное рабочее пространство. Это означает:

- **Skills для каждого агента** находятся в `<workspace>/skills` и доступны только этому агенту.
- **Общие skills** находятся в `~/.openclaw/skills` (managed/local) и видны
  **всем агентам** на одной машине.
- **Общие папки** также можно добавить через `skills.load.extraDirs` (наинизший
  приоритет), если нужен общий набор skills для нескольких агентов.

Если один и тот же skill существует более чем в одном месте, применяется обычный приоритет:
workspace выигрывает, затем managed/local, затем bundled.

## Плагины + skills

Плагины могут поставлять собственные skills, указывая каталоги `skills` в
`openclaw.plugin.json` (пути относительно корня плагина). Skills плагина загружаются
при включении плагина и участвуют в стандартных правилах приоритета skills.
Вы можете открыть их через файл `metadata.openclaw.requires.config` в файле конфигурации плагина
. См. [Plugins](/tools/plugin) для обнаружения/настройки и [Tools](/tools) для описания
поверхности инструментов, которым обучают эти skills.

## ClawHub (установка + синхронизация)

ClawHub — это публичный реестр skills для OpenClaw. Просмотр доступен по адресу
[https://clawhub.com](https://clawhub.com). Используйте его для поиска, установки, обновления и резервного копирования skills.
Полное руководство: [ClawHub](/tools/clawhub).

Общие потоки:

- Установка skill в рабочее пространство:
  - `clawhub install <skill-slug>`
- Обновление всех установленных skills:
  - `clawhub update --all`
- Синхронизация (сканирование + публикация обновлений):
  - `clawhub sync --all`

По умолчанию `clawhub` устанавливает skills в `./skills` в текущем рабочем
каталоге (или использует настроенное рабочее пространство OpenClaw). OpenClaw
подхватывает это как `<workspace>/skills` в следующем сеансе.

## Примечания по безопасности

- Рассматривайте сторонние skills как **недоверенный код**. Читайте их перед включением.
- Предпочитайте "песочница" запусков для ненадежных входов и рискованных инструментов. См. [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` и `skills.entries.*.apiKey` внедряют секреты в процесс **хоста**
  для данного хода агента (не в sandbox). Не допускайте попадания секретов в подсказки и логи.
- Для более широкой модели угроз и чек‑листов см. [Security](/gateway/security).

## Формат (AgentSkills + совместимость с Pi)

`SKILL.md` должен включать как минимум:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Примечания:

- Мы следуем спецификации AgentSkills для структуры и назначения.
- Парсер, используемый встроенным агентом, поддерживает только **однострочные** ключи frontmatter.
- `metadata` должен быть **однострочным JSON‑объектом**.
- Используйте `{baseDir}` в инструкциях для ссылки на путь папки skill.
- Необязательные ключи frontmatter:
  - `homepage` — URL, отображаемый как «Website» в macOS Skills UI (также поддерживается через `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (по умолчанию: `true`). При `true` skill доступен как пользовательская slash‑команда.
  - `disable-model-invocation` — `true|false` (по умолчанию: `false`). При `true` skill исключается из подсказки модели (но остаётся доступным через вызов пользователем).
  - `command-dispatch` — `tool` (необязательно). При значении `tool` slash‑команда обходит модель и напрямую диспетчеризуется в инструмент.
  - `command-tool` — имя инструмента для вызова, когда задано `command-dispatch: tool`.
  - `command-arg-mode` — `raw` (по умолчанию). Для диспетчеризации инструмента передаёт исходную строку аргументов в инструмент (без парсинга ядром).

    Инструмент вызывается с параметрами:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Гейтинг (фильтры во время загрузки)

OpenClaw **фильтрует skills во время загрузки**, используя `metadata` (однострочный JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Поля в `metadata.openclaw`:

- `always: true` — всегда включать skill (пропустить остальные проверки).
- `emoji` — необязательный эмодзи, используемый в macOS Skills UI.
- `homepage` — необязательный URL, отображаемый как «Website» в macOS Skills UI.
- `os` — необязательный список платформ (`darwin`, `linux`, `win32`). Если задан, skill доступен только на этих ОС.
- `requires.bins` — список; каждый элемент должен существовать на `PATH`.
- `requires.anyBins` — список; хотя бы один должен существовать на `PATH`.
- `requires.env` — список; переменная окружения должна существовать **или** быть задана в конфиге.
- `requires.config` — список путей `openclaw.json`, которые должны быть истинными.
- `primaryEnv` — имя переменной окружения, связанной с `skills.entries.<name>.apiKey`.
- `install` — необязательный массив спецификаций установщиков, используемых macOS Skills UI (brew/node/go/uv/download).

Примечание о sandboxing:

- `requires.bins` проверяется на **хосте** во время загрузки skill.
- Если агент работает в sandbox, бинарник также должен существовать **внутри контейнера**.
  Установите его через `agents.defaults.sandbox.docker.setupCommand` (или используйте пользовательский образ).
  `setupCommand` выполняется один раз после создания контейнера.
  Установки пакетов также требуют сетевого доступа, доступной для записи корневой ФС и пользователя root в sandbox.
  Пример: skill `summarize` (`skills/summarize/SKILL.md`) требует наличия CLI `summarize`
  в контейнере sandbox для выполнения там.

Пример установщика:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Примечания:

- Если указано несколько установщиков, Gateway выбирает **один** предпочтительный вариант (brew при наличии, иначе node).
- Если все установщики имеют значение `download`, OpenClaw перечисляет каждый элемент, чтобы вы могли видеть доступные артефакты.
- Спецификации установщиков могут включать `os: ["darwin"|"linux"|"win32"]` для фильтрации вариантов по платформе.
- Установки Node учитывают `skills.install.nodeManager` в `openclaw.json` (по умолчанию: npm; варианты: npm/pnpm/yarn/bun).
  Это влияет только на **установку skills**; среда выполнения Gateway всё равно должна быть Node
  (Bun не рекомендуется для WhatsApp/Telegram).
- Установки Go: если `go` отсутствует и доступен `brew`, gateway сначала устанавливает Go через Homebrew и по возможности устанавливает `GOBIN` в `bin` от Homebrew.
- Установки через download: `url` (обязательно), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (по умолчанию: auto при обнаружении архива), `stripComponents`, `targetDir` (по умолчанию: `~/.openclaw/tools/<skillKey>`).

Если `metadata.openclaw` отсутствует, skill всегда доступен (если только
он не отключён в конфиге или не заблокирован `skills.allowBundled` для bundled skills).

## Переопределения конфига (`~/.openclaw/openclaw.json`)

Bundled/managed skills можно включать/выключать и снабжать значениями переменных окружения:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Примечание: если имя skill содержит дефисы, заключите ключ в кавычки (JSON5 допускает ключи в кавычках).

Ключи конфига по умолчанию соответствуют **имени skill**. Если skill определяет
`metadata.openclaw.skillKey`, используйте этот ключ в `skills.entries`.

Правила:

- `enabled: false` отключает skill, даже если он bundled/установлен.
- `env`: внедряется **только если** переменная ещё не установлена в процессе.
- `apiKey`: удобство для skills, которые объявляют `metadata.openclaw.primaryEnv`.
- `config`: необязательный контейнер для пользовательских полей per‑skill; пользовательские ключи должны находиться здесь.
- `allowBundled`: необязательный список разрешённых только для **bundled** skills. Если задан, доступны только bundled skills из списка (managed/workspace skills не затрагиваются).

## Впрыскивание среды (на каждого агента)

При старте запуска агента OpenClaw:

1. Считывает метаданные skills.
2. Применяет любые `skills.entries.<key>.env` или `skills.entries.<key>.apiKey` к
   `process.env`.
3. Формирует системную подсказку с **доступными** skills.
4. Восстанавливает исходное окружение после завершения запуска.

Это **ограничено запуском агента**, а не глобальным окружением оболочки.

## Снимок сеанса (производительность)

OpenClaw делает снимок доступных skills **при начале сеанса** и повторно использует этот список для последующих ходов в рамках того же сеанса. Изменения в skills или конфиге вступают в силу при следующем новом сеансе.

Skills также могут обновляться в середине сеанса, когда включён наблюдатель skills или когда появляется новый доступный удалённый узел (см. ниже). Рассматривайте это как **горячую перезагрузку**: обновлённый список применяется на следующем ходе агента.

## Удалённые узлы macOS (Linux gateway)

Если Gateway запущен на Linux, но подключён **узел macOS** **с разрешённым `system.run`** (без установки безопасности Exec approvals в `deny`), OpenClaw может считать skills только для macOS доступными, когда требуемые бинарники присутствуют на этом узле. Агент должен выполнять такие skills через инструмент `nodes` (обычно `nodes.run`).

Это опирается на отчёт узла о поддерживаемых командах и на проверку бинарников через `system.run`. Если узел macOS позже отключится, skills останутся видимыми; вызовы могут завершаться ошибкой до повторного подключения узла.

## Наблюдатель skills (автообновление)

По умолчанию OpenClaw отслеживает папки skills и обновляет снимок skills при изменении файлов `SKILL.md`. Это настраивается в `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Влияние на токены (список skills)

Когда skills доступны, OpenClaw внедряет компактный XML‑список доступных skills в системную подсказку (через `formatSkillsForPrompt` в `pi-coding-agent`). Стоимость детерминирована:

- **Базовые накладные расходы (только при ≥1 skill):** 195 символов.
- **На каждый skill:** 97 символов + длина XML‑экранированных значений `<name>`, `<description>` и `<location>`.

Формула (в символах):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Примечания:

- XML‑экранирование расширяет `& < > " '` в сущности (`&amp;`, `&lt;` и т. д.), увеличивая длину.
- Количество токенов зависит от токенизатора модели. Грубая оценка в стиле OpenAI — ~4 символа на токен, поэтому **97 символов ≈ 24 токена** на skill плюс фактические длины полей.

## Жизненный цикл managed skills

OpenClaw поставляется с базовым набором skills как **bundled skills** в составе
установки (npm‑пакет или OpenClaw.app). `~/.openclaw/skills` существует для локальных
переопределений (например, закрепление версии/патчинг skill без изменения bundled‑копии). Workspace skills принадлежат пользователю и при конфликте имён переопределяют оба варианта.

## Справочник конфига

См. [Skills config](/tools/skills-config) для полной схемы конфигурации.

## Ищете больше skills?

Просмотрите [https://clawhub.com](https://clawhub.com).

---
