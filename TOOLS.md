# TOOLS.md - Локальные системные заметки

## Что здесь важно для тебя

### OpenClaw

- Конфиг: `~/.openclaw/openclaw.json`
- Gateway local: `ws://127.0.0.1:18789`

### Агентные настройки (на момент обновления)

- `agent=developer` модель: `openai-codex/gpt-5.3-codex-spark`
- `tools.sessions.visibility: all` — включает кросс-сессионную доставку между агентами

### Services (локальные)

#### MTProto Bridge (Telegram)

- Каталог: `/Users/assistant/.openclaw/services/mtproto-bridge`
- Статус: проверяется `./scripts/status.sh`
- Health endpoint: `http://127.0.0.1:8787/health`
- Основные команды:
  - `cd ~/.openclaw/services/mtproto-bridge`
  - `make start`
  - `make stop`
  - `./scripts/status.sh`

#### Diplodoc (wiki.vaganian.tech)

- Каталог: `/Users/assistant/.openclaw/services/diplodoc`
- Репозиторий: `git remote -v` → `origin = https://github.com/Percique/wiki.vaganian.tech.git`
- Быстрый цикл обновления контента:
  - правки в `docs/` и `docs/toc.yaml`
  - `make deploy` (rebuild + restart web)
  - проверь локально: `curl -I http://127.0.0.1:8080/toc.js`
- Вариант через скрипт: `./scripts/deploy.sh`

#### Data Platform

- Каталог: `/Users/assistant/.openclaw/services/data-platform`
- Используется как часть Telegram-инжеста (см. `WIKI.md`).

## Telegram/MTProto настройки (без секретов)

- Публичные флаги:
  - `AUTO_REPLY_DMS=true`
  - `ALLOWED_DM_USERNAMES=robertvaganian,percique`
  - `GROUP_DIGEST_ENABLED=true`

## Ссылки

- Не хранить в репозитории открытые секреты:
  - `.env` (mtproto)
  - `userbot.session`
- Логи: `~/.openclaw/services/mtproto-bridge/logs/`
