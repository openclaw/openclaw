---
summary: "Используйте подписку Claude Max/Pro как API-эндпоинт, совместимый с OpenAI"
read_when:
  - Вы хотите использовать подписку Claude Max с инструментами, совместимыми с OpenAI
  - Вам нужен локальный API‑сервер, который оборачивает Claude Code CLI
  - Вы хотите сэкономить, используя подписку вместо API‑ключей
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** — это инструмент сообщества, который предоставляет вашу подписку Claude Max/Pro как API‑эндпоинт, совместимый с OpenAI. Это позволяет использовать вашу подписку с любым инструментом, поддерживающим формат API OpenAI.

## Зачем это использовать?

| Подход              | Стоимость                                                                              | Лучше всего подходит для                   |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Anthropic API       | Оплата за токен (~$15/M вход, $75/M выход для Opus) | Продакшн‑приложения, высокий объём         |
| Подписка Claude Max | $200/месяц, фиксировано                                                                | Личное использование, разработка, безлимит |

Если у вас есть подписка Claude Max и вы хотите использовать её с инструментами, совместимыми с OpenAI, этот прокси может существенно сэкономить средства.

## Как это работает

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Прокси:

1. Принимает запросы в формате OpenAI по адресу `http://localhost:3456/v1/chat/completions`
2. Преобразует их в команды Claude Code CLI
3. Возвращает ответы в формате OpenAI (поддерживается стриминг)

## Установка

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Использование

### Запуск сервера

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Тестирование

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### С OpenClaw

Вы можете указать OpenClaw на прокси как на пользовательский эндпоинт, совместимый с OpenAI:

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## Доступные модели

| ID модели         | Карты           |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Автозапуск на macOS

Создайте LaunchAgent для автоматического запуска прокси:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## Ссылки

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Примечания

- Это **инструмент сообщества**, официально не поддерживается Anthropic или OpenClaw
- Требуется активная подписка Claude Max/Pro с аутентифицированным Claude Code CLI
- Прокси работает локально и не отправляет данные на сторонние серверы
- Потоковые ответы полностью поддерживаются

## См. также

- [Провайдер Anthropic](/providers/anthropic) — нативная интеграция OpenClaw с Claude через setup-token или API‑ключи
- [Провайдер OpenAI](/providers/openai) — для подписок OpenAI/Codex
