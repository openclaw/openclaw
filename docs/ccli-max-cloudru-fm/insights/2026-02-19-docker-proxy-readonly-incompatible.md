# Docker Proxy: read_only и non-root несовместимы с uv entrypoint

**Дата:** 2026-02-19
**Компонент:** `src/agents/cloudru-proxy-template.ts`

## Симптомы

- Контейнер `openclaw-cloudru-proxy` падал при запуске с ошибкой прав доступа
- `pnpm openclaw health` показывал proxy как недоступный сразу после `docker compose up`
- Docker не мог скачать образ с тегом `:v1.0.0` — такой тег не существует

## Суть проблемы

Три проблемы одновременно:

1. **read_only: true** — монтировал файловую систему контейнера как read-only, блокируя запись в `/app/.venv` и `/root/.cache`, которые нужны `uv run` при запуске
2. **user: "1000:1000"** — запускал контейнер от non-root пользователя, у которого нет прав записи в `/root/.cache` (принадлежит root)
3. **Тег образа `:v1.0.0`** — `legard/claude-code-proxy` публикует только тег `:latest`, тег `:v1.0.0` не существует

Образ `legard/claude-code-proxy` использует `uv run` как entrypoint. `uv` (Python package manager) должен записывать в `/app/.venv` и `/root/.cache` при каждом старте контейнера.

## Решение

1. Убрали `read_only: true` из Docker Compose шаблона
2. Убрали `user: "1000:1000"` из Docker Compose шаблона
3. Изменили тег образа с `:v1.0.0` на `:latest` в `CLOUDRU_PROXY_IMAGE`
4. Оставшееся security hardening сохранено: `no-new-privileges`, `cap_drop: ALL`, localhost-only port, resource limits, health check

## Ключевые файлы

- `src/agents/cloudru-proxy-template.ts` — генератор Docker Compose YAML (убраны `read_only`, `user`)
- `src/config/cloudru-fm.constants.ts` — константа `CLOUDRU_PROXY_IMAGE` (тег `:v1.0.0` → `:latest`)
