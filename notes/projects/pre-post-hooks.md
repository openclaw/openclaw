# Проект: PRE/POST Hooks для ответов

## Статус: В планах

## Цель
Добавить программный enforcement чеклистов — механические проверки в коде которые гарантируют выполнение PRE и POST шагов.

---

## Изменения в коде

### 1. Новые типы событий
**Файл:** `src/hooks/internal-hooks.ts`

```typescript
export type InternalHookEventType = 
  "command" | "session" | "agent" | "gateway" | "response";

// Новые события:
// response:pre — до формирования ответа
// response:post — после формирования, до отправки
```

### 2. Триггеры в agent runner
**Файл:** `src/auto-reply/reply/agent-runner-execution.ts`

```typescript
// ДО вызова runWithModelFallback (около строки 95):
await triggerInternalHook(createInternalHookEvent(
  "response",
  "pre",
  params.sessionKey,
  {
    prompt: params.commandBody,
    sessionCtx: params.sessionCtx,
    config: params.followupRun.run.config,
    workspaceDir: params.followupRun.run.workspaceDir,
  }
));

// ПОСЛЕ получения runResult (около строки 350):
const postEvent = createInternalHookEvent(
  "response",
  "post", 
  params.sessionKey,
  {
    runResult,
    prompt: params.commandBody,
    config: params.followupRun.run.config,
    workspaceDir: params.followupRun.run.workspaceDir,
  }
);
await triggerInternalHook(postEvent);

// Если POST hook добавил сообщения — append к ответу
if (postEvent.messages.length > 0) {
  // Добавить в runResult или отправить отдельно
}
```

### 3. PRE-hook
**Путь:** `src/hooks/bundled/response-pre/`

Функции:
- Читать SESSION-STATE.md → добавлять в контекст
- Классифицировать задачу по ключевым словам
- Определять нужный скилл
- Читать learnings проекта если применимо

### 4. POST-hook  
**Путь:** `src/hooks/bundled/response-post/`

Функции:
- Проверять полноту ответа (LLM анализ если нужно)
- Записывать в memory/YYYY-MM-DD.md
- Обновлять SESSION-STATE.md
- Записывать ошибки в learnings

### 5. Блокировка/модификация ответа
Если POST проверка не прошла:
- Вариант A: Добавить предупреждение к ответу
- Вариант B: Retry с инструкцией исправить
- Вариант C: Логировать для анализа

---

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `src/hooks/internal-hooks.ts` | Добавить `response` в InternalHookEventType |
| `src/auto-reply/reply/agent-runner-execution.ts` | Триггеры pre/post |
| `src/hooks/bundled/response-pre/handler.ts` | Создать |
| `src/hooks/bundled/response-pre/HOOK.md` | Создать |
| `src/hooks/bundled/response-post/handler.ts` | Создать |
| `src/hooks/bundled/response-post/HOOK.md` | Создать |
| Тесты | Покрытие новых hooks |
| Docs | `docs/hooks/response-hooks.md` |

---

## Сложности

1. **Проверка полноты** — "ответил на все пункты" требует LLM анализа
2. **Производительность** — дополнительные операции на каждый ответ
3. **Блокировка** — как обрабатывать failed POST

---

## Приоритет
Средний — сначала тестируем простое решение (bootstrap hook)

## Создан
2026-02-03
