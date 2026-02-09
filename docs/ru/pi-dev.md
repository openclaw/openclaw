---
title: "Рабочий процесс разработки Pi"
---

# Рабочий процесс разработки Pi

Это руководство суммирует разумный рабочий процесс для работы над интеграцией pi в OpenClaw.

## Проверка типов и линтинг

- Проверка типов и сборка: `pnpm build`
- Линтинг: `pnpm lint`
- Проверка форматирования: `pnpm format`
- Полный контроль перед отправкой: `pnpm lint && pnpm build && pnpm test`

## Запуск тестов Pi

Используйте специальный скрипт для набора интеграционных тестов pi:

```bash
scripts/pi/run-tests.sh
```

Чтобы включить живой тест, который проверяет реальное поведение провайдера:

```bash
scripts/pi/run-tests.sh --live
```

Скрипт запускает все модульные тесты, связанные с pi, по следующим шаблонам:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Ручное тестирование

Рекомендуемый порядок действий:

- Запустите Gateway (шлюз) в режиме разработки:
  - `pnpm gateway:dev`
- Запустите агента напрямую:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Используйте TUI для интерактивной отладки:
  - `pnpm tui`

Для проверки поведения вызовов инструментов используйте запрос на действие `read` или `exec`, чтобы увидеть потоковую передачу инструментов и обработку полезной нагрузки.

## Сброс до чистого состояния

Состояние хранится в каталоге состояния OpenClaw. По умолчанию используется `~/.openclaw`. Если задана `OPENCLAW_STATE_DIR`, используйте вместо этого указанный каталог.

Чтобы сбросить всё:

- `openclaw.json` для конфига
- `credentials/` для профилей аутентификации и токенов
- `agents/<agentId>/sessions/` для истории сеансов агента
- `agents/<agentId>/sessions.json` для индекса сеансов
- `sessions/`, если существуют устаревшие пути
- `workspace/`, если вам нужно пустое рабочее пространство

Если требуется сбросить только сеансы, удалите `agents/<agentId>/sessions/` и `agents/<agentId>/sessions.json` для этого агента. Сохраните `credentials/`, если не хотите проходить повторную аутентификацию.

## Ссылки

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
