---
summary: "Справка CLI для `openclaw models` (status/list/set/scan, алиасы, фолбэки, аутентификация)"
read_when:
  - Вы хотите изменить модели по умолчанию или просмотреть статус аутентификации провайдеров
  - Вы хотите просканировать доступные модели/провайдеров и отладить профили аутентификации
title: "модели"
---

# `openclaw models`

Обнаружение моделей, сканирование и конфигурация (модель по умолчанию, фолбэки, профили аутентификации).

Связанное:

- Провайдеры + модели: [Models](/providers/models)
- Настройка аутентификации провайдера: [Getting started](/start/getting-started)

## Common commands

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` показывает разрешённые значения по умолчанию/фолбэки, а также обзор аутентификации.
Когда доступны снимки использования провайдера, раздел статуса OAuth/токенов включает
заголовки использования провайдера.
Добавьте `--probe`, чтобы выполнить живые проверки аутентификации для каждого настроенного профиля провайдера.
Проверки — это реальные запросы (могут расходовать токены и вызывать ограничения по частоте).
Используйте `--agent <id>`, чтобы проверить состояние модели/аутентификации настроенного агента. Если параметр опущен,
команда использует `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` при наличии, иначе
настроенного агента по умолчанию.

Примечания:

- `models set <model-or-alias>` принимает `provider/model` или алиас.
- Ссылки на модели разбираются путём разделения по **первому** `/`. Если ID модели содержит `/` (в стиле OpenRouter), укажите префикс провайдера (пример: `openrouter/moonshotai/kimi-k2`).
- Если вы опускаете провайдера, OpenClaw трактует ввод как алиас или модель для **провайдера по умолчанию** (работает только при отсутствии `/` в ID модели).

### `models status`

Параметры:

- `--json`
- `--plain`
- `--check` (выход 1=истёк/отсутствует, 2=истекает)
- `--probe` (живая проверка настроенных профилей аутентификации)
- `--probe-provider <name>` (проверить одного провайдера)
- `--probe-profile <id>` (повтор или идентификаторы профилей, разделённые запятыми)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (идентификатор настроенного агента; переопределяет `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` запускает поток аутентификации плагина провайдера (OAuth/ключ API). Используйте
`openclaw plugins list`, чтобы увидеть, какие провайдеры установлены.

Примечания:

- `setup-token` запрашивает значение setup-token (сгенерируйте его с помощью `claude setup-token` на любой машине).
- `paste-token` принимает строку токена, сгенерированную в другом месте или с помощью автоматизации.
