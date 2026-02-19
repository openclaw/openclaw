# Руководство по эксплуатации и обслуживанию OpenClaw Platform

> Версия: 1.0 | Дата: 2026-02-13

---

## 1. Мониторинг

### 1.1 Метрики конкурентности (ConcurrencyMetrics)

Интерфейс `ConcurrencyMetrics` (`src/concurrency/domain/metrics.ts`) отражает состояние пула воркеров.

| Метрика               | Описание                                                |
| --------------------- | ------------------------------------------------------- |
| `activeWorkers`       | Воркеры, обрабатывающие запросы                         |
| `idleWorkers`         | Свободные воркеры                                       |
| `queueDepth`          | Запросов в очереди ожидания                             |
| `totalProcessed`      | Обработано запросов с момента запуска                   |
| `totalErrors`         | Запросов, завершившихся ошибкой                         |
| `avgLatencyMs`        | Средняя задержка обработки (мс)                         |
| `p95LatencyMs`        | 95-й перцентиль задержки (мс)                           |
| `p99LatencyMs`        | 99-й перцентиль задержки (мс)                           |
| `throughputPerMinute` | Пропускная способность (запросов/мин)                   |
| `backpressureLevel`   | Уровень обратного давления, 0 (норма) -- 1 (перегрузка) |
| `stuckWorkers`        | Воркеры в состоянии "stuck"                             |

**Пороги алертов:** `backpressureLevel >= 0.7` -- warning; `>= 0.8` -- critical (запросы отклоняются);
`stuckWorkers > 0` -- немедленное расследование; `queueDepth > maxQueueSize * 0.8` -- переполнение.

### 1.2 Метрики AI Fabric

**Потребление токенов.** `TokenBudget.getUsage(tenantId)` возвращает `{ used, limit, remaining }`.
Сброс каждые 24 часа. Файл: `src/ai-fabric/application/token-budget.ts`.

**Rate-лимиты провайдеров.** `RateLimiter` (`src/ai-fabric/application/rate-limiter.ts`) -- скользящее
окно 60 сек. Отслеживает `requestsPerMinute`, `tokensPerMinute`, `concurrentRequests`.
Остаток квоты: `getRemainingQuota(providerId)`.

**Fallback-цепочки.** Структура `FallbackChain`: основная модель, список запасных,
`maxRetries`, `retryDelayMs`. Мониторить через события шины.

### 1.3 Логирование

Pino (`src/core/infra/logger.ts`) -- структурированные JSON-логи. Модульные дочерние логгеры
через `createLogger('ModuleName')`.

| Уровень | Код | Применение                    |
| ------- | --- | ----------------------------- |
| `trace` | 10  | Трассировка вызовов           |
| `debug` | 20  | Отладка, переходы состояний   |
| `info`  | 30  | Штатные операции              |
| `warn`  | 40  | Высокий backpressure, retry   |
| `error` | 50  | Ошибки обработчиков, таймауты |
| `fatal` | 60  | Критические сбои              |

В production -- уровень `info`. Для диагностики -- `debug`. `trace` -- только локально.

---

## 2. Конфигурация рантайма

### 2.1 ConcurrencyConfig (`src/concurrency/domain/config.ts`)

| Параметр                | По умолчанию | Описание                               |
| ----------------------- | ------------ | -------------------------------------- |
| `minWorkers`            | 1            | Минимум активных воркеров              |
| `maxWorkers`            | 4            | Максимум воркеров в пуле               |
| `maxQueueSize`          | 32           | Максимальный размер очереди            |
| `workerTimeoutMs`       | 120 000      | Таймаут обработки запроса (мс)         |
| `maxRequestsPerWorker`  | 100          | Запросов до рециклинга воркера         |
| `memoryLimitMb`         | 512          | Лимит памяти на воркер (МБ)            |
| `backpressureThreshold` | 0.7          | Порог активации backpressure (0-1)     |
| `heartbeatIntervalMs`   | 5 000        | Интервал heartbeat (мс)                |
| `stuckThresholdMs`      | 60 000       | Порог определения "stuck" воркера (мс) |

Общее потребление RAM: `maxWorkers * memoryLimitMb` не должно превышать доступную память.

### 2.2 StreamConfig (`src/streaming/pipeline/types.ts`)

| Параметр                    | По умолчанию | Описание                        |
| --------------------------- | ------------ | ------------------------------- |
| `flushTokenThreshold`       | 50           | Токенов для сброса буфера       |
| `flushTimeoutMs`            | 500          | Таймаут сброса (мс)             |
| `maxMessageLength`          | 4 096        | Макс. длина сообщения           |
| `typingIndicatorIntervalMs` | 4 000        | Интервал индикатора набора (мс) |

Платформенные переопределения: **Web** -- `flush: 20/200ms`, без лимита длины.
**Telegram/Max** -- стандартные, лимит 4096. **API** -- без лимита длины, без typing.

### 2.3 Rate-лимиты мессенджеров (`src/messenger/domain/types.ts`, Token Bucket)

| Платформа  | rps | burstSize |
| ---------- | --- | --------- |
| `telegram` | 30  | 30        |
| `max`      | 20  | 20        |
| `web`      | 100 | 100       |
| `api`      | 100 | 100       |

### 2.4 Бюджеты токенов (`src/ai-fabric/application/token-budget.ts`)

| Тир        | Лимит / 24 ч |
| ---------- | ------------ |
| `free`     | 10 000       |
| `standard` | 100 000      |
| `premium`  | 1 000 000    |
| `admin`    | Infinity     |

Автосброс каждые 24 часа от момента первого использования.

---

## 3. Управление воркерами

### 3.1 Жизненный цикл и состояния

Файлы: `src/concurrency/domain/types.ts`, `src/concurrency/application/worker-lifecycle.ts`

```
idle --> busy --> idle            (нормальный цикл)
idle --> busy --> draining        (рециклинг: maxRequests или memoryLimit)
idle --> busy --> stuck --> dead   (зависание: нет heartbeat > stuckThresholdMs)
```

| Состояние  | Действие                                          |
| ---------- | ------------------------------------------------- |
| `idle`     | Готов принять запрос                              |
| `busy`     | Мониторить таймаут                                |
| `draining` | Не направлять новые запросы, ждать завершения     |
| `stuck`    | Принудительно завершить через `kill(workerId)`    |
| `dead`     | Удалить из пула, создать замену при необходимости |

### 3.2 Heartbeat и обнаружение зависаний

Воркер обновляет `lastHeartbeat` каждые `heartbeatIntervalMs` (5 сек).
При отсутствии heartbeat > `stuckThresholdMs` (60 сек) -- статус `stuck`,
принудительное завершение через `WorkerLifecycle.kill()`.

### 3.3 Рециклинг

Триггеры: `maxRequestsPerWorker` (100) или `memoryLimitMb` (512 МБ).
`recycle(workerId)`: draining -> kill -> удаление. Новый воркер по требованию.

### 3.4 Graceful shutdown

1. `isShuttingDown = true` -- новые запросы отклоняются (`BackpressureError`)
2. Ожидание опустошения очереди
3. Завершение всех воркеров через `lifecycle.kill()`

**Масштабирование воркеров:**

| Нагрузка   | min | max | queueSize |
| ---------- | --- | --- | --------- |
| <10 rps    | 1   | 2   | 32        |
| 10-50 rps  | 2   | 4   | 64        |
| 50-200 rps | 4   | 8   | 128       |
| >200 rps   | 8   | 16  | 256       |

---

## 4. Backpressure

Файл: `src/concurrency/application/backpressure.ts`

### Формула

```
backpressureLevel = min(queueDepth/maxQueueSize, 1.0) * 0.7
                  + activeWorkers/(activeWorkers+idleWorkers) * 0.3
```

При `level >= backpressureThreshold` (0.7) -- `shouldReject()` возвращает `true`,
запросы отклоняются с `BackpressureError`.

### Адаптивное масштабирование (`suggestWorkerCount`)

| Уровень    | Рекомендация                |
| ---------- | --------------------------- |
| < 0.5      | `minWorkers`                |
| 0.5 -- 0.8 | Пропорциональное увеличение |
| >= 0.8     | `maxWorkers`                |

**Алертинг:** Warning при `> 0.5` более 5 минут. Critical при `> 0.8` более 1 минуты.

---

## 5. Управление тенантами

### 5.1 Жизненный цикл (`src/session/domain/tenant.ts`)

```
[создание] --> active <--> suspended --> [удаление]
```

Функции: `createUserTenant` (тир `free`), `touchTenant`, `changeTenantTier`,
`suspendTenant`, `reinstateTenant`.

### 5.2 Тиры доступа (`src/core/types/access-tier.ts`)

Иерархия: `free < standard < premium < admin`.
Маппинг в sandbox: free->restricted, standard->standard, premium/admin->full.

| Тир        | Sandbox    | Бюджет токенов  |
| ---------- | ---------- | --------------- |
| `free`     | restricted | 10 000 / 24ч    |
| `standard` | standard   | 100 000 / 24ч   |
| `premium`  | full       | 1 000 000 / 24ч |
| `admin`    | full       | Безлимитный     |

### 5.3 Сессии (`src/session/domain/tenant-session.ts`)

Состояния: `idle -> active -> processing -> active` (цикл), `active -> expired` (TTL),
любое -> `suspended`. TTL по умолчанию: 60 минут. Продление: `extendSession(session, ms)`.

Очистка: `sessionStore.findExpired(now)` -> `transitionSession(s, 'expired')` -> `delete(id)`.

---

## 6. Обслуживание плагинов

### 6.1 Стейт-машина (`src/plugins/domain/state-machine.ts`)

```
registered --> installed --> active <--> disabled
                  |            |           |
                  +-> error <--+------->---+
                       |
                       +--> disabled (единственный выход)
```

Допустимые переходы: registered->{installed,error}, installed->{active,error},
active->{disabled,error}, disabled->{active,error}, error->{disabled}.

### 6.2 Восстановление из error

1. Прочитать `PluginInstance.errorMessage`
2. Устранить причину (конфигурация, зависимости, права)
3. `transitionPlugin(state, 'disabled')` -> `transitionPlugin('disabled', 'active')`

### 6.3 Разрешения и хуки

Разрешения (`PluginPermission`): `read_messages`, `send_messages`, `read_files`,
`write_files`, `execute_tools`, `access_network`.

Хуки (`HookName`): `onMessageReceived`, `onBeforeSend`, `onAfterSend`, `onToolInvoked`,
`onToolCompleted`, `onSessionStart`, `onSessionEnd`. Приоритет: меньше число -- раньше.

---

## 7. Безопасность (операционная)

**Ротация webhook-секретов:** сгенерировать (`openssl rand -hex 32`) -> обновить env ->
обновить на платформе -> мониторить ошибки 10 мин -> удалить старый.

**API-ключи:** только env/secret store, не в коде. Ротация -- каждые 90 дней.

**Path traversal:** workspace-пути изолированы (`/workspaces/${tenantId}`).
Проверять отсутствие `..` в `workspacePath`.

**Аудит тиров:** регулярно проверять тенантов с `admin`. Функция `isTierAtLeast()`.

**Бюджеты:** мониторить аномальное потребление. `admin` (Infinity) -- особый контроль.

---

## 8. Резервное копирование и восстановление

Архитектура использует in-memory хранилища (`Map`), данные не персистентны.

| Данные  | Метод                               | Частота       |
| ------- | ----------------------------------- | ------------- |
| Тенанты | Сериализация `ITenantStore` в JSON  | Каждые 5 мин  |
| Сессии  | Сериализация `ISessionStore` в JSON | Каждые 5 мин  |
| Плагины | Экспорт `PluginRegistry`            | При изменении |
| Метрики | Экспорт `ConcurrencyMetrics`        | Каждую минуту |
| Бюджеты | Экспорт `TokenBudget.usage`         | Каждые 5 мин  |

**Журнал событий:** `InProcessEventBus` не хранит историю. Для аудита --
`subscribeAll()` с записью во внешнее хранилище.

**Восстановление:** остановить -> загрузить бэкапы тенантов/сессий/плагинов ->
пересоздать бюджеты (обнулятся при потере) -> запустить -> проверить minWorkers.

---

## 9. Масштабирование

### 9.1 Горизонтальное

Для нескольких инстансов необходимо вынести:

- `ITenantStore`/`ISessionStore` -> Redis/PostgreSQL
- `InProcessEventBus` -> Redis Pub/Sub, NATS
- `SessionMutex` -> Redlock
- `TokenBudget` -> централизованный счетчик

### 9.2 Вертикальное

| Параметр          | Рекомендация                 |
| ----------------- | ---------------------------- |
| `maxWorkers`      | 1 на ядро CPU                |
| `memoryLimitMb`   | Суммарно <= 80% RAM          |
| `maxQueueSize`    | 4x-8x от maxWorkers          |
| `workerTimeoutMs` | 2x от ожидаемого max latency |

**Rate-лимиты:** при горизонтальном масштабировании -- пропорционально снижать лимиты.
Telegram -- глобальный лимит 30 msg/sec на бота.

---

## 10. Диагностика проблем

| Проблема             | Симптомы                          | Решение                                                                           |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Высокий backpressure | `BackpressureError`, отказы       | Увеличить `maxWorkers`/`maxQueueSize`, проверить stuck workers                    |
| Застрявшие воркеры   | `stuckWorkers > 0`, рост задержек | Проверить `stuckThresholdMs`, задержки AI-провайдера; увеличить `workerTimeoutMs` |
| Rate limit           | `RateLimitError`                  | Проверить `PLATFORM_RATE_LIMITS`; использовать `retryAfterMs`; добавить кэш       |
| Бюджет токенов       | `TokenBudgetExceededError`        | `getUsage(tenantId)`; повысить тир или ждать 24ч сброса                           |
| Ошибка плагина       | Состояние `error`                 | Прочитать `errorMessage`; проверить permissions и requiredTier; disable->activate |
| Ошибки событий       | `"Event handler error"` в логах   | Ошибки изолированы; проверить handler по `eventType` в логе                       |

---

## 11. Чеклист обслуживания

### Ежедневно

- [ ] Проверить `backpressureLevel`, `stuckWorkers`, `queueDepth`
- [ ] Просмотреть логи `error` и `fatal`
- [ ] Проверить аномальное потребление токенов
- [ ] Убедиться: `activeWorkers + idleWorkers >= minWorkers`

### Еженедельно

- [ ] Анализ трендов `p95LatencyMs` и `p99LatencyMs`
- [ ] Просмотр логов `warn` на повторяющиеся предупреждения
- [ ] Распределение потребления токенов по тирам
- [ ] Аудит плагинов: состояния, плагины в `error`
- [ ] Размер in-memory хранилищ (тенанты, сессии)
- [ ] Очистка истекших сессий: `sessionStore.findExpired()`
- [ ] Анализ частоты срабатывания rate-лимитов

### Ежемесячно

- [ ] Ротация webhook-секретов и API-ключей AI-провайдеров
- [ ] Аудит тенантов с тиром `admin`
- [ ] Ревизия разрешений плагинов
- [ ] Удаление неактивных тенантов (`lastActiveAt` > 30 дней)
- [ ] Пересмотр `ConcurrencyConfig` на основе статистики
- [ ] Тест восстановления из резервной копии
- [ ] Проверка path traversal в workspace-путях
- [ ] Обновление зависимостей (pino и др.)

---

## Справочник файлов

| Компонент                   | Файл                                              |
| --------------------------- | ------------------------------------------------- |
| Метрики конкурентности      | `src/concurrency/domain/metrics.ts`               |
| Конфигурация конкурентности | `src/concurrency/domain/config.ts`                |
| Пул воркеров                | `src/concurrency/application/worker-pool.ts`      |
| Backpressure                | `src/concurrency/application/backpressure.ts`     |
| Жизненный цикл воркеров     | `src/concurrency/application/worker-lifecycle.ts` |
| Rate-лимитер AI             | `src/ai-fabric/application/rate-limiter.ts`       |
| Бюджет токенов              | `src/ai-fabric/application/token-budget.ts`       |
| Rate-лимитер мессенджеров   | `src/messenger/application/rate-limiter.ts`       |
| Шина событий                | `src/core/infra/event-bus.ts`                     |
| Логгер                      | `src/core/infra/logger.ts`                        |
| Тенант                      | `src/session/domain/tenant.ts`                    |
| Сессия тенанта              | `src/session/domain/tenant-session.ts`            |
| Стейт-машина плагинов       | `src/plugins/domain/state-machine.ts`             |
| Реестр плагинов             | `src/plugins/application/plugin-registry.ts`      |
| Жизненный цикл плагинов     | `src/plugins/application/plugin-lifecycle.ts`     |
| Конфигурация стриминга      | `src/streaming/pipeline/types.ts`                 |
| Тиры доступа                | `src/core/types/access-tier.ts`                   |
