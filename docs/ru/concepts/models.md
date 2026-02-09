---
summary: "Models CLI: список, установка, алиасы, фолбэки, сканирование, статус"
read_when:
  - Добавление или изменение CLI моделей (models list/set/scan/aliases/fallbacks)
  - Изменение поведения фолбэков моделей или UX выбора
  - Обновление зондов сканирования моделей (инструменты/изображения)
title: "Models CLI"
---

# Models CLI

[/concepts/model-failover](/concepts/model-failover) для ротации профилей аутентификации,
cooldown-периодов и того, как это взаимодействует с фолбэками.
Краткий обзор провайдеров + примеры: [/concepts/model-providers](/concepts/model-providers).

## Как работает выбор модели

OpenClaw выбирает модели в следующем порядке:

1. **Основная** модель (`agents.defaults.model.primary` или `agents.defaults.model`).
2. **Фолбэки** в `agents.defaults.model.fallbacks` (по порядку).
3. **Failover аутентификации провайдера** происходит внутри провайдера перед
   переходом к следующей модели.

Связанные понятия:

- `agents.defaults.models` — это список разрешённых/каталог моделей, которые может использовать OpenClaw (плюс алиасы).
- `agents.defaults.imageModel` используется **только тогда**, когда основная модель не принимает изображения.
- Значения по умолчанию для каждого агента могут переопределять `agents.defaults.model` через `agents.list[].model` и биндинги (см. [/concepts/multi-agent](/concepts/multi-agent)).

## Быстрый выбор моделей (анекдотично)

- **GLM**: немного лучше для программирования и вызова инструментов.
- **MiniMax**: лучше для письма и «вайба».

## Мастер настройки (рекомендуется)

Если вы не хотите вручную редактировать конфиг, запустите мастер онбординга:

```bash
openclaw onboard
```

Он может настроить модель и аутентификацию для распространённых провайдеров,
включая **OpenAI Code (Codex) subscription** (OAuth) и **Anthropic**
(рекомендуется ключ API; также поддерживается `claude setup-token`).

## Ключи конфигурации (обзор)

- `agents.defaults.model.primary` и `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` и `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (список разрешённых + алиасы + параметры провайдера)
- `models.providers` (пользовательские провайдеры, записываемые в `models.json`)

Ссылки на модели нормализуются к нижнему регистру. Алиасы провайдеров, такие как
`z.ai/*`, нормализуются к `zai/*`.

Примеры конфигурации провайдеров (включая OpenCode Zen) находятся в
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## «Model is not allowed» (и почему ответы прекращаются)

Если задан `agents.defaults.models`, он становится **списком разрешённых** для `/model`
и для переопределений сеанса. Когда пользователь выбирает модель, которой нет в этом списке,
OpenClaw возвращает:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Это происходит **до** генерации обычного ответа, поэтому может показаться,
что система «не ответила». Исправление — одно из следующих:

- Добавить модель в `agents.defaults.models`, или
- Очистить список разрешённых (удалить `agents.defaults.models`), или
- Выбрать модель из `/model list`.

Пример конфигурации списка разрешённых:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Переключение моделей в чате (`/model`)

Вы можете переключать модели для текущего сеанса без перезапуска:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Примечания:

- `/model` (и `/model list`) — это компактный нумерованный выбор (семейство моделей + доступные провайдеры).
- `/model <#>` выбирает из этого списка.
- `/model status` — это детальный вид (кандидаты аутентификации и, при настройке, endpoint провайдера `baseUrl` + режим `api`).
- Ссылки на модели разбираются путём разделения по **первому** `/`. Используйте `provider/model` при вводе `/model <ref>`.
- Если идентификатор модели сам содержит `/` (в стиле OpenRouter), необходимо указать префикс провайдера (пример: `/model openrouter/moonshotai/kimi-k2`).
- Если вы опускаете провайдера, OpenClaw трактует ввод как алиас или модель для **провайдера по умолчанию** (работает только когда в ID модели нет `/`).

Полное поведение команд и конфигурация: [Slash commands](/tools/slash-commands).

## Команды CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (без подкоманды) — это сокращение для `models status`.

### `models list`

По умолчанию показывает настроенные модели. Полезные флаги:

- `--all`: полный каталог
- `--local`: только локальные провайдеры
- `--provider <name>`: фильтр по провайдеру
- `--plain`: по одной модели в строке
- `--json`: машиночитаемый вывод

### `models status`

Показывает разрешённую основную модель, фолбэки, модель для изображений и обзор
аутентификации настроенных провайдеров. Также отображает статус истечения OAuth
для профилей, найденных в хранилище аутентификации (по умолчанию предупреждает за 24 часа). `--plain` выводит только разрешённую основную модель.
Статус OAuth показывается всегда (и включается в вывод `--json`). Если у настроенного провайдера нет учётных данных, `models status` выводит раздел
**Missing auth**.
JSON включает `auth.oauth` (окно предупреждений + профили) и `auth.providers`
(эффективная аутентификация по провайдерам).
Используйте `--check` для автоматизации (код выхода `1` при отсутствии/истечении,
`2` — при скором истечении).

Предпочтительная аутентификация Anthropic — setup-token CLI Claude Code
(запускается где угодно; при необходимости вставьте на хосте шлюза Gateway):

```bash
claude setup-token
openclaw models status
```

## Сканирование (бесплатные модели OpenRouter)

`openclaw models scan` анализирует **каталог бесплатных моделей** OpenRouter и может
опционально зондировать модели на поддержку инструментов и изображений.

Ключевые флаги:

- `--no-probe`: пропустить живые пробы (только метаданные)
- `--min-params <b>`: минимальный размер параметров (в миллиардах)
- `--max-age-days <days>`: пропустить старые модели
- `--provider <name>`: фильтр по префиксу провайдера
- `--max-candidates <n>`: размер списка фолбэков
- `--set-default`: установить `agents.defaults.model.primary` в первый выбор
- `--set-image`: установить `agents.defaults.imageModel.primary` в первый выбор для изображений

Зондирование требует API-ключ OpenRouter (из профилей аутентификации или
`OPENROUTER_API_KEY`). Без ключа используйте `--no-probe` только для вывода кандидатов.

Результаты сканирования ранжируются по:

1. Поддержке изображений
2. Задержке инструментов
3. Размеру контекста
4. Количеству параметров

Входные данные

- Список OpenRouter `/models` (фильтр `:free`)
- Требуется API-ключ OpenRouter из профилей аутентификации или `OPENROUTER_API_KEY` (см. [/environment](/help/environment))
- Необязательные фильтры: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Управление зондированием: `--timeout`, `--concurrency`

При запуске в TTY можно интерактивно выбрать фолбэки. В неинтерактивном режиме
передайте `--yes` для принятия значений по умолчанию.

## Реестр моделей (`models.json`)

Пользовательские провайдеры в `models.providers` записываются в `models.json`
в каталоге агента (по умолчанию `~/.openclaw/agents/<agentId>/models.json`). Этот файл
объединяется по умолчанию, если только `models.mode` не установлен в `replace`.
