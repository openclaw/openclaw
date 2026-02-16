# Руководство администратора

## Обзор

Данное руководство предназначено для системных администраторов и DevOps-инженеров, отвечающих за эксплуатацию OpenClaw с расширением MAX Messenger в продакшн-среде.

---

## Структура файлов и каталогов

| Путь                                    | Назначение                                       |
| --------------------------------------- | ------------------------------------------------ |
| `~/.openclaw/openclaw.json`             | Основной конфигурационный файл (JSON5)           |
| `~/.openclaw/credentials/`              | Учётные данные OAuth и токены                    |
| `~/.openclaw/.env`                      | Переменные окружения (загружаются автоматически) |
| `/tmp/openclaw/`                        | Логи, lock-файлы, временные данные               |
| `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | Ротируемые логи (один файл в день)               |

Переопределение путей:

```bash
export OPENCLAW_CONFIG_PATH="/etc/openclaw/openclaw.json"
export OPENCLAW_STATE_DIR="/var/lib/openclaw"
```

---

## Управление конфигурацией

### Формат конфигурации

Конфигурация хранится в **JSON5** (JSON с комментариями и trailing comma):

```json5
{
  // Каналы доставки сообщений
  channels: {
    max: {
      enabled: true,
      botToken: "token", // или tokenFile для продакшна
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },

  // Логирование
  logging: {
    level: "info",
    file: "/var/log/openclaw/openclaw-YYYY-MM-DD.log",
  },
}
```

### Изменение конфигурации на лету

Конфигурация канала MAX поддерживает **горячую перезагрузку**. При изменении ключей с префиксом `channels.max` канал перезапускается автоматически:

```bash
# Через CLI
openclaw config set channels.max.dmPolicy "allowlist"
openclaw config set channels.max.botToken "новый-токен"

# Или прямое редактирование файла
# (изменения подхватываются при следующем цикле reload)
```

Перезагружаемые параметры:

- `channels.max.botToken` / `channels.max.tokenFile`
- `channels.max.dmPolicy` / `channels.max.allowFrom`
- `channels.max.groupPolicy` / `channels.max.groupAllowFrom`
- `channels.max.webhookUrl` / `channels.max.webhookSecret`
- `channels.max.enabled`
- Все параметры в `channels.max.accounts.*`

### Валидация конфигурации

```bash
# Проверка конфигурации
openclaw doctor

# Автоматическое исправление
openclaw doctor --fix
```

Zod-схема проверяет:

- Типы всех полей (строки, числа, булевы)
- Формат URL для `webhookUrl` (должен быть валидный URL)
- Правило: `dmPolicy="open"` требует `allowFrom: ["*"]`
- Неизвестные поля отвергаются (strict mode)

---

## Управление сервисом

### Установка как системный демон

```bash
# Установить сервис (systemd на Linux, launchd на macOS)
openclaw gateway install

# Запустить
openclaw gateway start

# Остановить
openclaw gateway stop

# Перезапустить (при смене конфигурации)
openclaw gateway restart

# Проверить статус сервиса
openclaw gateway status

# Удалить сервис
openclaw gateway uninstall
```

### Ручной запуск (foreground)

```bash
openclaw gateway --port 18789 --verbose
```

### Принудительный перезапуск

Если шлюз завис или порт занят:

```bash
openclaw gateway --force
```

Флаг `--force` автоматически завершает процесс, занимающий указанный порт.

---

## Мониторинг

### Проверка здоровья

```bash
# Быстрая проверка
openclaw health --json

# Полная диагностика
openclaw gateway probe --json

# Глубокая проверка (probe каждого канала)
openclaw status --deep
```

Пример вывода `openclaw health --json`:

```json
{
  "healthy": true,
  "channels": {
    "max": {
      "configured": true,
      "running": true,
      "mode": "polling",
      "accounts": [
        {
          "accountId": "default",
          "enabled": true,
          "tokenSource": "config",
          "running": true,
          "probe": { "ok": true, "bot": { "username": "my_bot" } }
        }
      ]
    }
  }
}
```

### Control UI

Веб-интерфейс администрирования доступен по адресу шлюза:

```
http://127.0.0.1:18789
```

Функции Control UI:

- **Config** — редактор конфигурации (формы + Raw JSON)
- **Logs** — просмотр логов в реальном времени
- **Sessions** — активные сессии по каналам
- **Channels** — статус каждого канала

### Логирование

#### Конфигурация логов

```json5
{
  logging: {
    // Уровень для файла
    level: "info", // trace | debug | info | warn | error

    // Уровень для консоли
    consoleLevel: "info",

    // Стиль консольного вывода
    consoleStyle: "pretty", // pretty | compact | json

    // Путь к лог-файлу (поддерживает шаблон даты)
    file: "/var/log/openclaw/openclaw-YYYY-MM-DD.log",

    // Редактирование чувствительных данных
    redactSensitive: "tools", // off | tools
    redactPatterns: ["sk-[a-zA-Z0-9]+"],
  },
}
```

#### Просмотр логов

```bash
# В реальном времени
openclaw logs --follow

# Последние N строк
tail -100 /tmp/openclaw/openclaw-*.log

# Фильтрация по MAX-каналу
grep "\[max:" /tmp/openclaw/openclaw-*.log
```

#### Ключевые записи в логах MAX

| Запись                              | Значение                             |
| ----------------------------------- | ------------------------------------ |
| `starting MAX provider (@username)` | Канал успешно запущен                |
| `MAX probe failed: ...`             | Ошибка проверки токена               |
| `polling error (attempt N)`         | Ошибка polling, перезапуск с backoff |
| `webhook subscribed at URL`         | Webhook успешно подключён            |
| `webhook unsubscribed`              | Webhook отключён при остановке       |
| `received update: message_created`  | Получено входящее сообщение          |

---

## Безопасность

### Защита токена

**Рекомендации для продакшна:**

1. **Используйте tokenFile** вместо botToken в конфиге:

   ```json5
   {
     channels: {
       max: {
         tokenFile: "/run/secrets/max-bot-token",
       },
     },
   }
   ```

2. **Kubernetes Secrets:**

   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: max-bot-token
   data:
     token: <base64-encoded-token>
   ```

   ```json5
   { channels: { max: { tokenFile: "/run/secrets/max-bot-token/token" } } }
   ```

3. **Nix agenix:** Используйте `OPENCLAW_NIX_MODE=1` для read-only конфигурации.

4. **Никогда не коммитьте** `openclaw.json` с токенами в git. Используйте `.env` или секрет-менеджеры.

### Ограничение доступа к конфигурации

```bash
chmod 600 ~/.openclaw/openclaw.json
chmod 700 ~/.openclaw/
```

### Webhook-безопасность

Обязательно устанавливайте `webhookSecret` для верификации запросов от MAX API:

```json5
{
  channels: {
    max: {
      webhookUrl: "https://server.example.com/max/webhook",
      webhookSecret: "сгенерируйте-надёжный-секрет", // минимум 32 символа
    },
  },
}
```

MAX отправляет секрет в заголовке `X-Max-Bot-Api-Secret`.

### Аудит политик доступа

```bash
# Проверка потенциально опасных настроек
openclaw doctor
```

Предупреждения:

- `groupPolicy="open"` — бот реагирует во всех группах (mention-gated, но всё равно риск)
- `dmPolicy="open"` без явного `allowFrom: ["*"]` — ошибка валидации

---

## Управление аккаунтами

### Просмотр аккаунтов

```bash
openclaw status max
```

### Добавление аккаунта

```json5
{
  channels: {
    max: {
      accounts: {
        новый_аккаунт: {
          botToken: "новый-токен",
          dmPolicy: "allowlist",
          allowFrom: [123456789],
        },
      },
    },
  },
}
```

Канал перезапустится автоматически.

### Отключение аккаунта (без удаления)

```json5
{
  channels: {
    max: {
      accounts: {
        аккаунт: {
          enabled: false,
          // остальная конфигурация сохранена
        },
      },
    },
  },
}
```

### Удаление аккаунта (logout)

```bash
openclaw logout max --account <accountId>
```

Это удалит `botToken` и `tokenFile` из конфигурации аккаунта.

---

## Управление сопряжением

### Просмотр ожидающих запросов

```bash
openclaw pairing list max
```

### Одобрение запроса

```bash
openclaw pairing approve max <КОД>
```

### Отклонение запроса

```bash
openclaw pairing reject max <КОД>
```

Коды сопряжения действительны **1 час**. Максимум **3 ожидающих запроса** на канал.

---

## Обновление

### Обновление OpenClaw

```bash
# Через npm
npm update -g openclaw

# Через pnpm
pnpm update -g openclaw
```

### Обновление из исходников

```bash
cd openclaw
git pull
pnpm install
pnpm build
openclaw gateway restart
```

### Миграция конфигурации

При обновлении OpenClaw конфигурация мигрирует автоматически. Для проверки:

```bash
openclaw doctor
```

---

## Резервное копирование

### Что бэкапить

| Путь                         | Важность | Описание                            |
| ---------------------------- | -------- | ----------------------------------- |
| `~/.openclaw/openclaw.json`  | Критично | Основная конфигурация               |
| `~/.openclaw/credentials/`   | Критично | Учётные данные OAuth                |
| `/run/secrets/max-bot-token` | Критично | Токен (если используется tokenFile) |
| `/tmp/openclaw/`             | Низкая   | Логи (ротация 1 день)               |

### Пример бэкап-скрипта

```bash
#!/bin/bash
BACKUP_DIR="/backup/openclaw/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Конфигурация (без токенов для безопасности)
cp ~/.openclaw/openclaw.json "$BACKUP_DIR/"

# Учётные данные
cp -r ~/.openclaw/credentials/ "$BACKUP_DIR/"

echo "Backup saved to $BACKUP_DIR"
```

---

## Решение проблем

### Шлюз не запускается

```bash
# Проверка порта
ss -tlnp | grep 18789

# Принудительный запуск
openclaw gateway --force

# Проверка конфигурации
openclaw doctor
```

### MAX-канал не подключается

```bash
# Проверка сетевого доступа к MAX API
curl -H "Authorization: ваш-токен" https://platform-api.max.ru/me

# Проверка через прокси
curl --proxy http://proxy:8080 -H "Authorization: ваш-токен" https://platform-api.max.ru/me
```

### Высокая задержка ответов

1. Проверьте параметры стриминга:
   ```json5
   { channels: { max: { blockStreamingCoalesce: { minChars: 800, idleMs: 500 } } } }
   ```
2. Уменьшите `minChars` для более частых отправок
3. Уменьшите `idleMs` для более быстрого flush

### Потеря сообщений при polling

1. Переключитесь на webhook для большей надёжности
2. Проверьте логи на ошибки `polling error`
3. Убедитесь в стабильности сетевого соединения

### Ошибка 429 (Rate Limit)

MAX Bot API ограничивает частоту запросов (~30 rps). Включите retry:

```json5
// Retry включается программно в коде отправки
// Параметры по умолчанию: 3 попытки, 500ms-30s backoff
```

При массовых рассылках используйте задержки между отправками.
