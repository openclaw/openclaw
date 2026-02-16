# Руководство по установке и запуску

## Системные требования

| Компонент   | Требование                                                 |
| ----------- | ---------------------------------------------------------- |
| **Node.js** | >= 22.12.0                                                 |
| **pnpm**    | 10.23.0 (указан в packageManager)                          |
| **ОС**      | Linux, macOS, Windows (WSL рекомендуется)                  |
| **Сеть**    | Доступ к `platform-api.max.ru` (напрямую или через прокси) |
| **MAX-бот** | Токен от dev.max.ru                                        |

---

## Способ 1: Быстрая установка (рекомендуется)

### Linux / macOS / WSL

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
```

Без root-прав (локальная установка):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
```

### Windows PowerShell

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

### Через npm/pnpm

```bash
npm install -g openclaw@latest
# или
pnpm add -g openclaw@latest
```

---

## Способ 2: Сборка из исходников (для разработчиков)

```bash
# 1. Клонировать репозиторий
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 2. Установить зависимости
pnpm install

# 3. Собрать UI (при первом запуске)
pnpm ui:build

# 4. Собрать проект
pnpm build

# 5. Проверить сборку
pnpm lint
pnpm test
```

---

## Создание бота MAX

### Шаг 1: Регистрация бота

1. Откройте [dev.max.ru](https://dev.max.ru)
2. Войдите с аккаунтом MAX/VK
3. Создайте нового бота в разделе "Боты"
4. Скопируйте **токен бота**

> **Важно:** Публикация бота (видимость для всех пользователей MAX) требует верифицированного российского юридического лица. Для разработки и тестирования подтверждение не нужно.

### Шаг 2: Настройка OpenClaw

Есть три способа указать токен:

#### Вариант A: Через конфигурационный файл (рекомендуется)

```bash
# Создать/отредактировать конфигурацию
mkdir -p ~/.openclaw
```

Файл `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    max: {
      enabled: true,
      botToken: "ваш-токен-от-dev-max-ru",
      dmPolicy: "pairing",
    },
  },
}
```

#### Вариант B: Через переменную окружения

```bash
export MAX_BOT_TOKEN="ваш-токен-от-dev-max-ru"
```

Этот способ работает только для аккаунта по умолчанию. Для мультиаккаунта используйте конфиг.

#### Вариант C: Через файл с токеном (продакшн)

```json5
{
  channels: {
    max: {
      enabled: true,
      tokenFile: "/run/secrets/max-bot-token",
    },
  },
}
```

Файл должен содержать только токен (без переносов строк).

### Шаг 3: Интерактивная настройка (альтернатива)

```bash
openclaw onboard
```

Мастер настройки автоматически обнаружит `MAX_BOT_TOKEN` в окружении или попросит ввести токен вручную.

---

## Запуск шлюза

### Базовый запуск

```bash
openclaw gateway
```

Вывод при успешном запуске:

```
agent model: anthropic/claude-sonnet-4-5-20250929
listening on ws://127.0.0.1:18789 (PID 12345)
log file: /tmp/openclaw/openclaw-2026-02-16.log
[default] starting MAX provider (@имя_бота)
```

### Запуск с параметрами

```bash
# Кастомный порт
openclaw gateway --port 9000

# Подробное логирование
openclaw gateway --verbose

# Привязка к LAN (доступ из локальной сети)
openclaw gateway --bind lan

# Принудительный перезапуск (убить предыдущий процесс)
openclaw gateway --force

# Запуск с пропуском каналов (для отладки)
OPENCLAW_SKIP_CHANNELS=1 openclaw gateway
```

### Режим разработки

```bash
pnpm gateway:dev
```

Создаёт dev-конфигурацию и workspace при первом запуске. Для сброса состояния:

```bash
pnpm gateway:dev:reset
```

Автоперезагрузка при изменении кода:

```bash
pnpm gateway:watch
```

---

## Проверка работоспособности

### Проверка статуса

```bash
# Общий статус шлюза
openclaw status

# Детальный статус всех каналов
openclaw status --all

# Глубокая проверка (включая probe каждого канала)
openclaw status --deep

# Статус конкретно MAX-канала
openclaw status max

# Проверка здоровья шлюза (JSON)
openclaw health --json
```

### Проверка токена бота

При запуске шлюз автоматически вызывает `GET /me` для проверки токена. Если токен верный, в логе появится:

```
[default] starting MAX provider (@имя_бота)
```

Если токен неверный:

```
[default] MAX probe failed: Unauthorized
[default] starting MAX provider (unverified)
```

### Тест отправки сообщения

```bash
# Отправить тестовое сообщение (укажите chat ID)
openclaw send max <chat_id> "Привет из OpenClaw!"
```

---

## Настройка Webhook (опционально)

По умолчанию используется long polling. Для продакшн-среды рекомендуется webhook:

### Требования для Webhook

- Публичный HTTPS-URL (самоподписанные сертификаты не поддерживаются)
- Открытый порт для входящих запросов от MAX API

### Конфигурация

```json5
{
  channels: {
    max: {
      botToken: "ваш-токен",
      webhookUrl: "https://your-server.example.com/max/webhook",
      webhookSecret: "произвольный-секрет-для-верификации",
      webhookPath: "/max/webhook",
    },
  },
}
```

### Как это работает

1. При запуске OpenClaw отправляет `POST /subscriptions` на MAX API с указанным URL
2. MAX начинает доставлять обновления на этот URL
3. Каждый запрос содержит заголовок `X-Max-Bot-Api-Secret` для верификации
4. При остановке OpenClaw отправляет `DELETE /subscriptions` для отписки

---

## Настройка прокси

Если доступ к `platform-api.max.ru` возможен только через прокси:

```json5
{
  channels: {
    max: {
      proxy: "http://proxy.corp.example.com:8080",
    },
  },
}
```

Прокси применяется ко всем HTTP-запросам MAX-канала (probe, send, monitor).

---

## Мультиаккаунт

Для запуска нескольких ботов MAX с одного шлюза:

```json5
{
  channels: {
    max: {
      // Общие настройки (наследуются всеми аккаунтами)
      dmPolicy: "pairing",
      groupPolicy: "allowlist",

      accounts: {
        support: {
          botToken: "токен-бота-поддержки",
          dmPolicy: "open",
          allowFrom: ["*"],
        },
        sales: {
          botToken: "токен-бота-продаж",
          allowFrom: [111111111, 222222222],
        },
        staging: {
          enabled: false,
          tokenFile: "/run/secrets/staging-token",
        },
      },
    },
  },
}
```

Каждый аккаунт работает как независимый бот со своим polling/webhook-процессом.

---

## Установка как демон (systemd/launchd)

### Установка сервиса

```bash
openclaw gateway install
```

Или при первоначальной настройке:

```bash
openclaw onboard --install-daemon
```

### Управление сервисом

```bash
openclaw gateway start      # запустить
openclaw gateway stop       # остановить
openclaw gateway restart    # перезапустить
openclaw gateway status     # проверить статус
openclaw gateway uninstall  # удалить сервис
```

---

## Диагностика

### Команда doctor

```bash
# Проверка конфигурации
openclaw doctor

# Автоматическое исправление проблем
openclaw doctor --fix
```

### Типичные проблемы

| Проблема                         | Причина                 | Решение                                                     |
| -------------------------------- | ----------------------- | ----------------------------------------------------------- |
| "MAX probe failed: Unauthorized" | Неверный токен          | Проверьте токен на dev.max.ru                               |
| "ECONNREFUSED"                   | Нет доступа к API       | Проверьте сеть / настройте прокси                           |
| "webhook subscription failed"    | URL недоступен          | Убедитесь, что URL публичен и HTTPS                         |
| Бот не отвечает в группе         | Нет @упоминания         | Упомяните бота по имени или настройте `groupPolicy: "open"` |
| Код сопряжения не приходит       | `dmPolicy` не `pairing` | Установите `dmPolicy: "pairing"`                            |

### Логи

```bash
# Просмотр логов в реальном времени
openclaw logs --follow

# Или напрямую
tail -f /tmp/openclaw/openclaw-*.log
```

Для более детальных логов:

```json5
{
  logging: {
    level: "debug",
    consoleLevel: "debug",
  },
}
```

---

## Переменные окружения (полный список)

| Переменная                | Описание                              | По умолчанию                |
| ------------------------- | ------------------------------------- | --------------------------- |
| `MAX_BOT_TOKEN`           | Токен бота MAX (аккаунт по умолчанию) | —                           |
| `OPENCLAW_CONFIG_PATH`    | Путь к конфигурационному файлу        | `~/.openclaw/openclaw.json` |
| `OPENCLAW_STATE_DIR`      | Каталог состояния                     | `~/.openclaw`               |
| `OPENCLAW_GATEWAY_PORT`   | Порт шлюза                            | `18789`                     |
| `OPENCLAW_SKIP_CHANNELS`  | Пропустить запуск каналов             | `false`                     |
| `OPENCLAW_NIX_MODE`       | Режим Nix (read-only конфиг)          | `false`                     |
| `OPENCLAW_LOAD_SHELL_ENV` | Загрузить env из login shell          | `false`                     |
