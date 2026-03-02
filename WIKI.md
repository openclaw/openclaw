# WIKI — Личные системные заметки OpenClaw (developer workspace)

> Обновлено: 2026-03-02
>
## 1) Что изменено в агенте

- **Developer-агент**: модель по умолчанию для этого агента — `openai-codex/gpt-5.3-codex-spark`.
- **Main/общая модель**: в глобальных настройках `agents.defaults.model.primary` сейчас `openai-codex/gpt-5.3-codex`.
- Включена настройка межсессионной видимости:
  - `tools.sessions.visibility = "all"`
  - это нужно для работы `sessions_send` между агентами (без лишних ошибок вида `Session send visibility is restricted`).

### О том, как я общаюсь с product-manager

- Передаём пинги через `sessions_send` после установки `tools.sessions.visibility=all`.
- Если не хотите, чтобы служебные межагентные пинги попадали в канал, используйте **не сессионный** режим (например, прямой `openclaw agent --session-id ...`) для внутренних задач, и/или договориться о шаблонах/таймингах.

## 2) MTProto сервис (Telegram userbot)

Сервис существует в отдельной директории:
- `/Users/assistant/.openclaw/services/mtproto-bridge`

Состав:
- `bridge.py` — слушает входящие TG-сообщения (Telethon).
- `adapter.py` — HTTP-интерфейс `/telegram/inbound` → `openclaw agent`.
- `scripts/` — `start.sh`, `stop.sh`, `status.sh`.

Текущий статус проверен:
- `adapter: UP`
- `bridge: UP`
- `health: UP`

Полезная команда:
```bash
cd ~/.openclaw/services/mtproto-bridge
./scripts/status.sh
```

## 3) Почему Telegram-ответы не всегда приходили

Основные причины, которые мы нашли:
1. Сообщения в группах/каналах: автоответ обычно отключён.
2. DM-чат только для allowlist-юзернеймов.
3. Конкретная связка пользователя/аккаунта и авторизации userbot.

Текущая логика:
- `ALLOWED_DM_USERNAMES=robertvaganian,percique`
- `AUTO_REPLY_DMS=true`
- `GROUP_DIGEST_ENABLED` накапливает групповую активность, но не отправляет автоответ в группу.

## 4) Команды по диагностике (частые)

```bash
# OpenClaw
openclaw status
openclaw status --deep
openclaw config get tools.sessions.visibility
openclaw config set tools.sessions.visibility all

# MTProto bridge
cd ~/.openclaw/services/mtproto-bridge
./scripts/status.sh
openclaw gateway restart   # при изменении конфига
```

## 5) Полезные ограничения/ссылки

- Не публиковать `.env` и `userbot.session` из `mtproto-bridge`.
- Логи `mtproto-bridge/logs/*.log` — источник правды по работе сервиса.
- Для полного анализа `telegram`-канала см. документацию OpenClaw в `docs` (внутри установки пакета).

## 6) Diplodoc: как обновлять wiki-сайт

Документация наружного вики живёт в репозитории:
- `/Users/assistant/.openclaw/services/diplodoc`

- Remote: `origin -> https://github.com/Percique/wiki.vaganian.tech.git`
- Базовая схема обновления после правок в `docs/`:

```bash
cd /Users/assistant/.openclaw/services/diplodoc

# 1) Редактирование:
# - docs/<...>.md
# - docs/toc.yaml

# 2) Локальная проверка после изменений
git status
git diff

# 3) Деплой сайта (rebuild + restart web)
make deploy

# 4) Если нужно подтвердить доступность
test -s "http://127.0.0.1:8080/toc.js"
```

Альтернатива шагам вручную:
```bash
cd /Users/assistant/.openclaw/services/diplodoc
./scripts/deploy.sh
```

Если хочешь форснутый CF cache purge — выставь `CF_API_TOKEN` и `CF_ZONE_ID` перед `make deploy`.

## 7) Git-процедуры для документации

Для локального `developer`-воркспейса (`~/.openclaw/workspace-developer`) git сейчас без remotes:
- фиксация изменений делается локально `git add ... && git commit -m "..."`
- пуш — только если настроен remote вручную.

Для `diplodoc` (вики на сайте):
```bash
cd /Users/assistant/.openclaw/services/diplodoc

git add docs/*.md docs/toc.yaml

git commit -m "docs: ..."

git push origin main
```

Рекомендуемый минимум после каждого публичного изменения в `/services/diplodoc/docs`:
- `make verify` (если есть) или проверка `curl` по `8080`
- commit в git
- push в `origin/main`
- `make deploy` для публикации
