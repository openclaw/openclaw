# Paginated Result: поле `items` → `data` в Cloud.ru API

**Дата:** 2026-02-19
**Компонент:** `src/ai-fabric/types.ts`

## Симптомы

- `listAgents()`, `listMcpServers()`, `listAgentSystems()` возвращали пустые списки
- `/status-agents` показывал 0 агентов при наличии работающих агентов в проекте
- `/ask-agent` не находил агентов для отправки сообщений
- Ошибок не было — TypeScript не ловит несуществующие поля на рантайме

## Суть проблемы

Тип `PaginatedResult<T>` определял массив результатов в поле `items`, но реальный Cloud.ru AI Fabric REST API возвращает массив в поле `data`. Обращение к `result.items` давало `undefined`, а `result.data` содержал реальные данные.

```typescript
// Было
export type PaginatedResult<T> = { items: T[]; total: number };
// Стало
export type PaginatedResult<T> = { data: T[]; total: number };
```

## Решение

1. Переименовали поле в типе `PaginatedResult<T>`: `items` → `data`
2. Обновили все 4+ вызова в потребителях: `result.items` → `result.data`

## Ключевые файлы

- `src/ai-fabric/types.ts` — тип `PaginatedResult<T>`
- `src/ai-fabric/agent-status.ts` — `result.items` → `result.data`
- `src/commands/setup-ai-fabric.ts` — 4 места: `discoverMcpServers()`, `discoverAgents()`, `setupAiFabricNonInteractive()`
