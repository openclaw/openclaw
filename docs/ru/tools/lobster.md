---
title: Lobster
summary: "Типизированная среда выполнения рабочих процессов для OpenClaw с возобновляемыми шлюзами подтверждений."
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Вам нужны детерминированные многошаговые рабочие процессы с явными подтверждениями
  - Вам нужно возобновлять рабочий процесс без повторного выполнения предыдущих шагов
---

# Lobster

Lobster — это оболочка рабочих процессов, которая позволяет OpenClaw запускать многошаговые последовательности инструментов как одну детерминированную операцию с явными контрольными точками подтверждения.

## Hook

Ваш ассистент может создавать инструменты, которые управляют им самим. Попросите рабочий процесс — и через 30 минут у вас есть CLI плюс конвейеры, которые выполняются одним вызовом. Lobster — недостающий элемент: детерминированные конвейеры, явные подтверждения и возобновляемое состояние.

## Why

Сегодня сложные рабочие процессы требуют множества возвратно-поступательных вызовов инструментов. Каждый вызов стоит токенов, и LLM должна оркестрировать каждый шаг. Lobster переносит эту оркестрацию в типизированную среду выполнения:

- **Один вызов вместо многих**: OpenClaw выполняет один вызов инструмента Lobster и получает структурированный результат.
- **Подтверждения встроены**: Побочные эффекты (отправка письма, публикация комментария) останавливают рабочий процесс до явного подтверждения.
- **Возобновляемость**: Остановленные рабочие процессы возвращают токен; подтвердите и возобновите без повторного выполнения всего.

## Why a DSL instead of plain programs?

Lobster намеренно минималистичен. Цель — не «новый язык», а предсказуемая, дружественная к ИИ спецификация конвейеров с первоклассными подтверждениями и токенами возобновления.

- **Подтверждение/возобновление встроены**: Обычная программа может запросить человека, но не может _поставить на паузу и возобновить_ с долговечным токеном без самостоятельного изобретения такой среды выполнения.
- **Детерминизм + аудитируемость**: Конвейеры — это данные, поэтому их легко логировать, сравнивать (diff), воспроизводить и проверять.
- **Ограниченная поверхность для ИИ**: Минимальная грамматика + JSON‑передача уменьшают «креативные» пути выполнения кода и делают валидацию реалистичной.
- **Политики безопасности встроены**: Тайм‑ауты, лимиты вывода, проверки sandbox и списки разрешённых применяются средой выполнения, а не каждым скриптом.
- **Всё ещё программируемо**: Каждый шаг может вызывать любой CLI или скрипт. Если нужен JS/TS, генерируйте файлы `.lobster` из кода.

## How it works

OpenClaw запускает локальный CLI `lobster` в **режиме инструмента** и разбирает JSON‑конверт из stdout.
Если конвейер приостанавливается для подтверждения, инструмент возвращает `resumeToken`, чтобы вы могли продолжить позже.

## Pattern: small CLI + JSON pipes + approvals

Создавайте небольшие команды, которые говорят на JSON, затем связывайте их в один вызов Lobster. (Имена команд ниже — примеры; подставляйте свои.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Если конвейер запрашивает подтверждение, возобновите с токеном:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

ИИ инициирует рабочий процесс; Lobster выполняет шаги. Шлюзы подтверждений делают побочные эффекты явными и пригодными для аудита.

Пример: сопоставление входных элементов с вызовами инструментов:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

Для рабочих процессов, которым нужен **структурированный шаг LLM**, включите необязательный плагин‑инструмент
`llm-task` и вызывайте его из Lobster. Это сохраняет детерминизм рабочего процесса, позволяя при этом классифицировать/резюмировать/черновить с помощью модели.

Включите инструмент:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Используйте его в конвейере:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Подробности и параметры конфигурации см. в [LLM Task](/tools/llm-task).

## Workflow files (.lobster)

Lobster может выполнять файлы рабочих процессов YAML/JSON с полями `name`, `args`, `steps`, `env`, `condition` и `approval`. В вызовах инструментов OpenClaw установите `pipeline` в путь к файлу.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Примечания:

- `stdin: $step.stdout` и `stdin: $step.json` передают вывод предыдущего шага.
- `condition` (или `when`) может ставить шаги на шлюз по `$step.approved`.

## Install Lobster

Установите CLI Lobster на **том же хосте**, где работает Gateway (шлюз) OpenClaw (см. [репозиторий Lobster](https://github.com/openclaw/lobster)), и убедитесь, что `lobster` находится в `PATH`.
Если вы хотите использовать пользовательское расположение бинарника, передайте **абсолютный** `lobsterPath` в вызове инструмента.

## Enable the tool

Lobster — **необязательный** плагин‑инструмент (по умолчанию отключён).

Рекомендуется (аддитивно, безопасно):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Или для каждого агента:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Избегайте использования `tools.allow: ["lobster"]`, если вы не намерены работать в ограничительном режиме списка разрешённых.

Примечание: списки разрешённых являются opt‑in для необязательных плагинов. Если ваш список разрешённых содержит только
плагин‑инструменты (например, `lobster`), OpenClaw оставляет основные инструменты включёнными. Чтобы ограничить основные
инструменты, включите в список разрешённых также нужные основные инструменты или группы.

## Example: Email triage

Без Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

С Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Возвращает JSON‑конверт (усечённый):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Пользователь подтверждает → возобновление:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Один рабочий процесс. Детерминированный. Безопасный.

## Tool parameters

### `run`

Запуск конвейера в режиме инструмента.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Запуск файла рабочего процесса с аргументами:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Продолжение остановленного рабочего процесса после подтверждения.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Абсолютный путь к бинарнику Lobster (не указывайте, чтобы использовать `PATH`).
- `cwd`: Рабочий каталог для конвейера (по умолчанию — текущий рабочий каталог процесса).
- `timeoutMs`: Принудительно завершить подпроцесс, если он превышает эту длительность (по умолчанию: 20000).
- `maxStdoutBytes`: Принудительно завершить подпроцесс, если stdout превышает этот размер (по умолчанию: 512000).
- `argsJson`: JSON‑строка, передаваемая в `lobster run --args-json` (только для файлов рабочих процессов).

## Output envelope

Lobster возвращает JSON‑конверт с одним из трёх статусов:

- `ok` → успешно завершено
- `needs_approval` → приостановлено; для возобновления требуется `requiresApproval.resumeToken`
- `cancelled` → явно отклонено или отменено

Инструмент выводит конверт как в `content` (красиво отформатированный JSON), так и в `details` (сырой объект).

## Approvals

Если присутствует `requiresApproval`, просмотрите запрос и примите решение:

- `approve: true` → возобновить и продолжить побочные эффекты
- `approve: false` → отменить и завершить рабочий процесс

Используйте `approve --preview-from-stdin --limit N`, чтобы прикреплять JSON‑превью к запросам подтверждения без пользовательского jq/heredoc‑клея. Токены возобновления теперь компактны: Lobster хранит состояние возобновления рабочего процесса в своём каталоге состояния и возвращает небольшой ключ‑токен.

## OpenProse

OpenProse хорошо сочетается с Lobster: используйте `/prose` для оркестрации подготовки несколькими агентами, затем запускайте конвейер Lobster для детерминированных подтверждений. Если программе Prose нужен Lobster, разрешите инструмент `lobster` для подагентов через `tools.subagents.tools`. См. [OpenProse](/prose).

## Safety

- **Только локальные подпроцессы** — сам плагин не выполняет сетевых вызовов.
- **Без секретов** — Lobster не управляет OAuth; он вызывает инструменты OpenClaw, которые это делают.
- **Совместим с sandbox** — отключён, когда контекст инструмента находится в sandbox.
- **Укреплённая безопасность** — если указан, `lobsterPath` должен быть абсолютным; тайм‑ауты и лимиты вывода принудительно применяются.

## Troubleshooting

- **`lobster subprocess timed out`** → увеличьте `timeoutMs` или разбейте длинный конвейер.
- **`lobster output exceeded maxStdoutBytes`** → увеличьте `maxStdoutBytes` или уменьшите размер вывода.
- **`lobster returned invalid JSON`** → убедитесь, что конвейер запускается в режиме инструмента и печатает только JSON.
- **`lobster failed (code …)`** → запустите тот же конвейер в терминале, чтобы проверить stderr.

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

Один публичный пример: CLI «second brain» + конвейеры Lobster, которые управляют тремя хранилищами Markdown (личное, партнёрское, общее). CLI выдаёт JSON со статистикой, списками входящих и сканированием устаревших записей; Lobster связывает эти команды в рабочие процессы вроде `weekly-review`, `inbox-triage`, `memory-consolidation` и `shared-task-sync`, каждый со шлюзами подтверждений. ИИ выполняет оценочные задачи (категоризация), когда доступен, и возвращается к детерминированным правилам, когда нет.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
