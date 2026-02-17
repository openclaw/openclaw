# Ручной ввод URL агентов и MCP серверов

Инструкция по настройке Cloud.ru AI Fabric через визард **без IAM-авторизации** — с ручным вводом эндпоинтов MCP серверов и AI агентов.

## Запуск

```bash
pnpm openclaw onboard --auth-choice cloudru-fm-gpt-oss --cloudru-api-key <ваш-ключ>
```

Для dev-режима:

```bash
pnpm openclaw --dev onboard --auth-choice cloudru-fm-gpt-oss --cloudru-api-key <ваш-ключ>
```

> API-ключ записывается в `.env` для прокси. Если прокси не нужен — подойдёт любая строка.

## Навигация по визарду

| Шаг          | Промпт                                    | Ответ                                                      |
| ------------ | ----------------------------------------- | ---------------------------------------------------------- |
| Docker proxy | "Start Docker proxy?"                     | **No** (если Docker не нужен)                              |
| AI Fabric    | "Connect Cloud.ru AI Fabric MCP servers?" | **Yes**                                                    |
| IAM          | "Do you have Cloud.ru IAM credentials?"   | **No**                                                     |
| Project ID   | "Cloud.ru AI Fabric project ID"           | ID вашего проекта                                          |
| MCP          | "Enter MCP server URLs manually?"         | **Yes**                                                    |
|              | "MCP server name"                         | например `web-search`                                      |
|              | "MCP server URL"                          | полный URL: `https://ai-agents.api.cloud.ru/mcp/mcp-xxx`   |
|              | "Add another MCP server?"                 | Yes / No                                                   |
| Agents       | "Enter AI Agent endpoints manually?"      | **Yes**                                                    |
|              | "Agent name"                              | например `code-assistant`                                  |
|              | "Agent A2A endpoint URL"                  | полный URL: `https://ai-agents.api.cloud.ru/a2a/agent-xxx` |
|              | "Add another agent?"                      | Yes / No                                                   |

## Результат

### MCP конфиг (`claude-mcp-cloudru.json`)

Создаётся в рабочей директории:

```json
{
  "mcpServers": {
    "web-search": {
      "url": "https://ai-agents.api.cloud.ru/mcp/mcp-xxx",
      "transport": "sse"
    }
  }
}
```

URL сохраняется **ровно как введён** (не конструируется из base + id).

### Основной конфиг (`openclaw.json`)

Секция `aiFabric`:

```json
{
  "aiFabric": {
    "enabled": true,
    "projectId": "ваш-project-id",
    "agents": [
      {
        "id": "manual-code-assistant",
        "name": "code-assistant",
        "endpoint": "https://ai-agents.api.cloud.ru/a2a/agent-xxx"
      }
    ],
    "mcpConfigPath": "<workspace>/claude-mcp-cloudru.json"
  }
}
```

Обратите внимание:

- `keyId` **отсутствует** — IAM был пропущен
- `agents[].id` имеет префикс `manual-`
- CLI backend автоматически получает аргументы `--strict-mcp-config --mcp-config <path>`

### Dev vs Production

|               | Конфиг                          | Порт gateway |
| ------------- | ------------------------------- | ------------ |
| Production    | `~/.openclaw/openclaw.json`     | 18789        |
| Dev (`--dev`) | `~/.openclaw-dev/openclaw.json` | 19001        |
