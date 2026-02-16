# OpenClaw Platform -- Руководство по установке и настройке

## 1. Системные требования

| Компонент | Минимальная версия | Примечание |
|-----------|-------------------|------------|
| Node.js | >= 22.12.0 | ES2022, ESM-модули |
| pnpm | >= 10.0.0 | Менеджер пакетов (corepack enable) |
| TypeScript | ^5.5.0 | Устанавливается как devDependency |
| Git | >= 2.30 | Для клонирования репозитория |

Проверьте установленные версии:

```bash
node --version   # v22.12.0 или выше
pnpm --version   # 10.x или выше
git --version
```

> **Важно:** Проект использует ES-модули (`"type": "module"` в package.json) и pnpm как менеджер пакетов.
> Node.js 22+ обязателен для полной поддержки ESM и API `import.meta`. Для активации pnpm: `corepack enable`.

---

## 2. Установка

```bash
# Клонирование репозитория
git clone https://github.com/your-org/openclaw-platform.git
cd openclaw-platform

# Установка зависимостей
pnpm install
```

После установки убедитесь, что проект собирается и тесты проходят:

```bash
pnpm run build
pnpm test
```

---

## 3. Зависимости

### Runtime-зависимости

| Пакет | Версия | Назначение |
|-------|--------|------------|
| `pino` | ^9.0.0 | Структурированное логирование (JSON-формат) |

### Dev-зависимости

| Пакет | Версия | Назначение |
|-------|--------|------------|
| `typescript` | ^5.5.0 | Компилятор TypeScript |
| `vitest` | ^2.0.0 | Фреймворк для тестирования |
| `@vitest/coverage-v8` | ^2.0.0 | Отчёты о покрытии кода |
| `eslint` | ^9.39.2 | Статический анализ кода |
| `typescript-eslint` | ^8.55.0 | ESLint-интеграция с TypeScript |
| `@typescript-eslint/eslint-plugin` | ^8.55.0 | Правила линтинга для TypeScript |
| `@typescript-eslint/parser` | ^8.55.0 | Парсер TypeScript для ESLint |
| `@types/node` | ^25.2.3 | Типы для Node.js API |

---

## 4. Конфигурация TypeScript

Полная конфигурация находится в `tsconfig.json`. Основные параметры:

| Параметр | Значение | Описание |
|----------|----------|----------|
| `target` | ES2022 | Современный JS (top-level await, `Array.at()`) |
| `module` | Node16 | Нативная ESM-поддержка |
| `outDir` | `dist` | Каталог скомпилированного кода |
| `strict` | true | Все strict-флаги включены |
| `declaration` | true | Генерация `.d.ts` файлов |
| `declarationMap` | true | Source map для деклараций |
| `sourceMap` | true | Source map для отладки |
| `noUncheckedIndexedAccess` | true | `obj[key]` возвращает `T \| undefined` |
| `noUnusedLocals` | true | Запрет неиспользуемых переменных |
| `noUnusedParameters` | true | Запрет неиспользуемых параметров |

**`strict: true`** включает: `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitAny`, `noImplicitThis`, `alwaysStrict`.

---

## 5. Сборка проекта

```bash
pnpm run build       # tsc -b            -- компиляция в ./dist
pnpm run typecheck   # tsc --noEmit      -- только проверка типов
pnpm run check       # typecheck + test  -- полная проверка перед коммитом
pnpm run clean       # rm -rf dist/ coverage/
```

---

## 6. Запуск тестов

Проект использует **Vitest** (793 теста, 33 тестовых файла):

```bash
# Запуск всех тестов
pnpm test

# Режим наблюдения (перезапуск при изменениях)
pnpm run test:watch

# Отчёт о покрытии кода (V8-провайдер)
pnpm run test:coverage
```

Тесты организованы по bounded-контекстам в директории `tests/`:

```
tests/
  core/           # DI-контейнер, типы, event bus
  session/        # Тенанты, сессии, workspace
  concurrency/    # Worker pool, планировщик, mutex
  streaming/      # Парсер потоков, аккумулятор токенов
  messenger/      # Telegram/Web адаптеры, webhook router
  mcp/            # Реестр инструментов, оркестратор
  training/       # Примеры, обратная связь, контекст
  plugins/        # Жизненный цикл плагинов, права
  ai-fabric/      # Провайдеры моделей, rate limiter
```

---

## 7. Линтинг

```bash
pnpm run lint
```

Конфигурация ESLint (`eslint.config.js`) использует пресет **`strictTypeChecked`** из `typescript-eslint` -- наиболее строгий набор правил. Ключевые настройки:

| Правило | Значение | Описание |
|---------|----------|----------|
| `@typescript-eslint/no-explicit-any` | `error` | Полный запрет `any` |
| `@typescript-eslint/no-non-null-assertion` | `error` | Запрет оператора `!` |
| `@typescript-eslint/no-unused-vars` | `error` | Неиспользуемые переменные (с исключением `_`-префикса) |
| `@typescript-eslint/restrict-template-expressions` | `error` | В шаблонных строках допускаются `number` и `boolean` |
| `@typescript-eslint/explicit-function-return-type` | `off` | Выведение типов разрешено |

Пресет `strictTypeChecked` дополнительно включает: `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-return` и другие правила с поддержкой type-aware анализа.

---

## 8. Настройка DI-контейнера

OpenClaw использует собственный DI-контейнер с ленивой инициализацией и заморозкой после конфигурации.

```typescript
import { createContainer, TOKENS } from '@openclaw/platform';
import type { IFileSystem, IHttpClient, ISubprocessFactory } from '@openclaw/platform';

// Реализуйте три внешних зависимости
const fileSystem: IFileSystem = { exists, readDir, mkdir, rmdir };
const httpClient: IHttpClient = { post };
const subprocessFactory: ISubprocessFactory = { spawn };

// Создание контейнера (все сервисы регистрируются как синглтоны)
const container = createContainer({ fileSystem, httpClient, subprocessFactory });

// Получение сервисов через типизированные токены
const eventBus = container.resolve(TOKENS.EVENT_BUS);
const webhookRouter = container.resolve(TOKENS.WEBHOOK_ROUTER);
const toolRegistry = container.resolve(TOKENS.TOOL_REGISTRY);
```

После вызова `createContainer` контейнер замораживается -- повторная регистрация невозможна. Автоматически создаются синглтоны для всех bounded-контекстов: Session, Concurrency, Streaming, Messenger, MCP, Training, Plugins, AI Fabric.

---

## 9. Настройка мессенджеров

### Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) в Telegram.
2. Сохраните полученный токен (`BOT_TOKEN`).
3. Настройте webhook через Telegram API:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-domain.com/webhook/telegram", "secret_token": "'${WEBHOOK_SECRET}'"}'
```

4. Зарегистрируйте адаптер в приложении:

```typescript
import { TelegramAdapter, TOKENS } from '@openclaw/platform';

const httpClient = container.resolve(TOKENS.HTTP_CLIENT);
const webhookRouter = container.resolve(TOKENS.WEBHOOK_ROUTER);

const telegramAdapter = new TelegramAdapter(
  httpClient,
  process.env.TELEGRAM_BOT_TOKEN!
);

webhookRouter.register('telegram', telegramAdapter, process.env.WEBHOOK_SECRET!);
```

### Web (REST API)

```typescript
import { TOKENS } from '@openclaw/platform';

const webAdapter = container.resolve(TOKENS.WEB_ADAPTER);
const webhookRouter = container.resolve(TOKENS.WEBHOOK_ROUTER);

webhookRouter.register('web', webAdapter, process.env.WEB_API_KEY!);
```

Клиенты отправляют запросы с заголовком `X-API-Key` или `Authorization: Bearer <key>`. Адаптер использует `timingSafeEqual` для защиты от timing-атак.

---

## 10. Переменные окружения

Создайте файл `.env` (не коммитьте его в репозиторий):

```bash
# === Обязательные ===

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # Токен от @BotFather
WEBHOOK_SECRET=your-random-secret-here  # Секрет для верификации вебхуков

# Web API
WEB_API_KEY=your-api-key-here           # Ключ аутентификации для web-клиентов

# === Опциональные ===

# Логирование (pino)
LOG_LEVEL=info                          # trace | debug | info | warn | error | fatal

# Окружение
NODE_ENV=production                     # development | production | test

# Рабочая директория
WORKSPACE_ROOT=/var/openclaw/workspaces # Корневой каталог для workspace тенантов

# Порт сервера
PORT=3000                               # Порт HTTP-сервера
```

> **Безопасность:** Файл `.env` должен быть добавлен в `.gitignore`. Никогда не храните секреты в исходном коде.

---

## 11. Первый запуск

```bash
git clone https://github.com/your-org/openclaw-platform.git
cd openclaw-platform
pnpm install
pnpm run build          # Компиляция
pnpm test               # Проверка (793 теста)
cp .env.example .env   # Создайте .env и заполните секреты
node dist/src/index.js # Запуск
```

Для режима разработки: `npx tsx --watch src/index.ts`

---

## 12. Docker (рекомендуемый деплой)

### Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm run build

# --- Production image ---
FROM node:22-alpine
WORKDIR /app

RUN addgroup -S openclaw && adduser -S openclaw -G openclaw

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

USER openclaw

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/src/index.js"]
```

### docker-compose.yml

```yaml
services:
  openclaw:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - WEB_API_KEY=${WEB_API_KEY}
      - WORKSPACE_ROOT=/data/workspaces
    volumes:
      - openclaw-data:/data/workspaces
    restart: unless-stopped
    mem_limit: 512m
    cpus: 1.0

volumes:
  openclaw-data:
```

```bash
docker compose up -d --build     # Сборка и запуск
docker compose logs -f openclaw  # Просмотр логов
docker compose down              # Остановка
```

---

## 13. Решение проблем

### Несовместимая версия Node.js

```
SyntaxError: Cannot use import statement outside a module
```

**Причина:** Node.js ниже версии 22 не полностью поддерживает ESM и API, используемые проектом.
**Решение:** Обновите Node.js до 22+. Используйте `nvm` для управления версиями:

```bash
nvm install 22
nvm use 22
```

### Ошибки компиляции TypeScript

```
error TS2322: Type 'X' is not assignable to type 'Y'
```

**Причина:** Включен `strict: true` с `noUncheckedIndexedAccess`. Индексный доступ возвращает `T | undefined`.
**Решение:** Используйте проверки на `undefined` или guard-функции перед обращением к значению.

### Тесты не проходят

```bash
npx vitest run tests/core/container.test.ts  # Диагностика конкретного файла
npx vitest run --reporter=verbose            # Подробный вывод
pnpm run clean && pnpm run build               # Очистка кэша сборки
```

### Конфликт портов

```
Error: listen EADDRINUSE :::3000
```

**Решение:** Измените порт через переменную `PORT` или найдите занимающий процесс:

```bash
lsof -i :3000
kill -9 <PID>
```

### ESLint: ошибки type-aware правил

```
Parsing error: ... was not found by the project service
```

**Причина:** Файл не включён в `tsconfig.json`.
**Решение:** Убедитесь, что файл находится в `src/` или `tests/` и соответствует паттернам `include` в tsconfig.
