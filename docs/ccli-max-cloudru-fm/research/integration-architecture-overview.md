# Архитектура интеграции: OpenClaw + MAX Messenger + Cloud.ru AI Agents

> **Версия документа:** 1.0
> **Дата:** 2026-02-13
> **Статус:** Проектирование
> **Автор:** OpenClaw Architecture Team

---

## Содержание

1. [Обзор](#1-обзор)
2. [Целевая архитектура](#2-целевая-архитектура)
3. [Потоки данных](#3-потоки-данных)
4. [Интеграционные паттерны](#4-интеграционные-паттерны)
5. [Модели данных](#5-модели-данных)
6. [Безопасность](#6-безопасность)
7. [Масштабирование](#7-масштабирование)
8. [Мониторинг и observability](#8-мониторинг-и-observability)
9. [Стоимость и оптимизация](#9-стоимость-и-оптимизация)
10. [Дорожная карта реализации](#10-дорожная-карта-реализации)
11. [Альтернативы и сравнение](#11-альтернативы-и-сравнение)
12. [Выводы и рекомендации](#12-выводы-и-рекомендации)

---

## 1. Обзор

### 1.1 Назначение документа

Настоящий документ описывает архитектуру интеграции платформы **OpenClaw** с двумя ключевыми российскими сервисами:

- **MAX Messenger** -- корпоративный и потребительский мессенджер (ранее известный как eXpress/VK Teams), используемый в качестве пользовательского интерфейса для взаимодействия с AI-агентами через чат-ботов и мини-приложения.
- **Cloud.ru AI Agents (Evolution AI Factory)** -- облачная платформа для развертывания и управления AI-агентами, включающая доступ к foundation-моделям (LLM), управляемый RAG, MCP-серверы и мультиагентные системы.

### 1.2 Бизнес-контекст

OpenClaw -- платформа оркестрации AI-агентов, обеспечивающая автоматизацию сложных задач через координацию множества специализированных агентов. Интеграция с MAX Messenger и Cloud.ru позволяет:

| Цель                 | Описание                                                             |
| -------------------- | -------------------------------------------------------------------- |
| **Доступность**      | Пользователи получают доступ к AI-агентам через привычный мессенджер |
| **Суверенность**     | Все данные обрабатываются и хранятся на территории РФ                |
| **Масштабируемость** | Cloud.ru обеспечивает эластичное масштабирование AI-инфраструктуры   |
| **Соответствие**     | Выполнение требований ФЗ-152 и ФСТЭК                                 |
| **Экономия**         | Serverless-модель Cloud.ru снижает стоимость владения                |

### 1.3 Ключевые стейкхолдеры

- **Конечные пользователи** -- взаимодействуют с системой через MAX Messenger
- **Администраторы** -- настраивают агентов и оркестрацию через CLI/API
- **DevOps-инженеры** -- развертывают и поддерживают инфраструктуру
- **Продуктовая команда** -- определяет сценарии использования и приоритеты

### 1.4 Ограничения и допущения

- MAX Bot API имеет ограничение 30 RPS на бота
- Cloud.ru Foundation Models API совместим с OpenAI API спецификацией
- Все компоненты OpenClaw развертываются в контейнерах (Docker/K8s)
- Используется TypeScript/Node.js как основной стек OpenClaw
- Сетевая связность между OpenClaw и Cloud.ru обеспечивается через публичный интернет или VPN

---

## 2. Целевая архитектура

### 2.1 Высокоуровневая схема (C4 Level 1 -- Context)

```
+-------------------------------------------------------------------------+
|                          Пользователи                                    |
|              MAX Messenger  /  Web-браузер  /  API-клиенты              |
+------------------+------------------+-------------------+----------------+
                   |                  |                   |
            MAX Bot API         HTTPS REST          WebSocket
                   |                  |                   |
+------------------v------------------v-------------------v----------------+
|                        OpenClaw Gateway                                  |
|                                                                          |
|  +---------------+   +----------------+   +----------------------------+ |
|  | MAX Bot       |   | REST API       |   | WebSocket Server           | |
|  | Handler       |   | Gateway        |   | (real-time events)         | |
|  |               |   |                |   |                            | |
|  | - Webhook     |   | - Auth         |   | - Bidirectional streaming  | |
|  | - Long Poll   |   | - Rate limit   |   | - Agent status updates    | |
|  | - Callbacks   |   | - Validation   |   | - Task progress           | |
|  +-------+-------+   +-------+--------+   +-------------+--------------+ |
|          |                    |                           |               |
|          +--------------------+---------------------------+               |
|                               |                                          |
|                    +----------v-----------+                              |
|                    |   Message Router     |                              |
|                    |                      |                              |
|                    | - Intent detection   |                              |
|                    | - Source normalization|                              |
|                    | - Priority routing   |                              |
|                    +----------+-----------+                              |
+-------------------------------|-----------------------------------------+
                                |
+-------------------------------v-----------------------------------------+
|                      OpenClaw Core Engine                                |
|                                                                          |
|  +----------------+  +----------------+  +-----------------------------+ |
|  | Task           |  | Agent          |  | Session Manager             | |
|  | Orchestrator   |  | Manager        |  |                             | |
|  |                |  |                |  | - User sessions (Redis)     | |
|  | - DAG executor |  | - Lifecycle    |  | - Conversation history      | |
|  | - Dependency   |  | - Health check |  | - Context window mgmt       | |
|  |   resolution   |  | - Pool mgmt   |  | - State persistence         | |
|  | - Retry logic  |  | - Routing      |  |                             | |
|  +-------+--------+  +-------+--------+  +-----------------------------+ |
|          |                    |                                           |
|          +--------------------+                                          |
|                    |                                                     |
|          +---------v-----------+                                         |
|          | Plugin / Tool       |                                         |
|          | Registry            |                                         |
|          +----------+----------+                                         |
+-------------------------------|-----------------------------------------+
                                |
+-------------------------------v-----------------------------------------+
|                Cloud.ru Evolution AI Factory                             |
|                                                                          |
|  +--------------------+    +------------------------------------------+ |
|  | Foundation         |    | AI Agents Service                        | |
|  | Models API         |    |                                          | |
|  |                    |    |  +-------------+    +-------------+      | |
|  | - GigaChat         |    |  | Agent 1     |    | Agent N     |      | |
|  | - Llama 3.x        |    |  | (Coder)     |    | (Analyst)   |      | |
|  | - Qwen 2.x         |    |  +-------------+    +-------------+      | |
|  | - DeepSeek          |    |                                          | |
|  | - Mistral           |    |  +--------------------------------------+| |
|  |                    |    |  | MCP Servers                           || |
|  | Endpoint:          |    |  |                                       || |
|  | /v1/chat/          |    |  | - Web Search    - File System         || |
|  |   completions      |    |  | - Code Exec     - Database            || |
|  |                    |    |  | - Custom Tools                        || |
|  +--------------------+    |  +--------------------------------------+| |
|                            |                                          | |
|  +--------------------+    |  +--------------------------------------+| |
|  | Managed RAG        |    |  | Agent Systems (A2A Protocol)         || |
|  |                    |    |  |                                       || |
|  | - Knowledge bases  |    |  | - Multi-agent coordination            || |
|  | - Document parsing |    |  | - Shared context                      || |
|  | - Vector search    |    |  | - Consensus mechanisms                || |
|  | - Chunking         |    |  +--------------------------------------+| |
|  +--------------------+    +------------------------------------------+ |
+-------------------------------------------------------------------------+
```

### 2.2 Компоненты системы -- детальное описание

#### 2.2.1 Frontend Layer (MAX Messenger)

MAX Messenger предоставляет два основных канала интеграции:

**MAX Bot (@maxhub/max-bot-api)**

Чат-бот на TypeScript, обрабатывающий текстовые команды и сообщения пользователей.

```
+-------------------------------------------------------------------+
|                        MAX Bot Architecture                        |
|                                                                    |
|  +------------------+     +------------------+                     |
|  | Event Listener   |     | Command Router   |                     |
|  |                  |     |                  |                     |
|  | - bot_started    +---->| /start           |                     |
|  | - message_created|     | /help            |                     |
|  | - message_callback     | /task <desc>     |                     |
|  | - message_edited |     | /agent <cmd>     |                     |
|  +------------------+     | /status          |                     |
|                           +--------+---------+                     |
|                                    |                               |
|  +------------------+     +--------v---------+                     |
|  | UI Components    |     | Response Builder |                     |
|  |                  |     |                  |                     |
|  | - InlineKeyboard |<----| - Text format    |                     |
|  | - Buttons        |     | - Markdown       |                     |
|  | - Carousel       |     | - File attach    |                     |
|  +------------------+     +------------------+                     |
+-------------------------------------------------------------------+
```

Ключевые характеристики:

| Параметр          | Значение                                          |
| ----------------- | ------------------------------------------------- |
| SDK               | `@maxhub/max-bot-api` (TypeScript)                |
| Транспорт         | Webhook (production) / Long Polling (development) |
| Rate Limit        | 30 RPS на бота                                    |
| Форматы сообщений | Text, Markdown, HTML, File attachments            |
| UI элементы       | InlineKeyboardMarkup, Buttons, Carousel           |
| Регистрация       | Через @MasterBot в MAX                            |

**MAX Mini App**

Веб-приложение, запускаемое внутри MAX Messenger, для расширенного UI-взаимодействия.

| Параметр    | Значение                                           |
| ----------- | -------------------------------------------------- |
| Технология  | React/Vue SPA внутри iframe                        |
| Bridge API  | `@max-platform/sdk` (события, данные пользователя) |
| Авторизация | MAX SSO через Bridge                               |
| Возможности | Полноценный веб-интерфейс для управления агентами  |

#### 2.2.2 Gateway Layer (OpenClaw)

**MAX Bot Handler**

Отвечает за прием и первичную обработку событий от MAX Messenger.

```typescript
// Упрощенная структура MAX Bot Handler
class MaxBotHandler {
  // Webhook endpoint: POST /api/webhooks/max
  async handleWebhook(req: Request): Promise<Response>;

  // Верификация подписи от MAX Platform
  verifySignature(body: string, signature: string): boolean;

  // Нормализация MAX-событий в OpenClawMessage
  normalizeEvent(event: MaxEvent): OpenClawMessage;

  // Отправка ответа через MAX Bot API
  sendResponse(chatId: string, response: AgentResponse): Promise<void>;
}
```

**REST API Gateway**

Обеспечивает прямой доступ к OpenClaw для внешних клиентов.

| Endpoint                        | Метод | Описание                    |
| ------------------------------- | ----- | --------------------------- |
| `/api/v1/tasks`                 | POST  | Создание задачи             |
| `/api/v1/tasks/:id`             | GET   | Статус задачи               |
| `/api/v1/agents`                | GET   | Список агентов              |
| `/api/v1/agents`                | POST  | Создание агента             |
| `/api/v1/sessions`              | POST  | Создание сессии             |
| `/api/v1/sessions/:id/messages` | POST  | Отправка сообщения в сессию |
| `/api/v1/health`                | GET   | Проверка здоровья сервиса   |

**WebSocket Server**

Real-time канал для двусторонней связи с клиентами.

```
Client                   WebSocket Server              Core Engine
  |                            |                            |
  |--- connect (auth token) -->|                            |
  |<-- connection_ack ---------|                            |
  |                            |                            |
  |--- subscribe(task:123) --->|                            |
  |<-- subscribed -------------|                            |
  |                            |                            |
  |                            |<-- task:123:progress ------|
  |<-- task_progress(50%) -----|                            |
  |                            |                            |
  |                            |<-- task:123:complete ------|
  |<-- task_complete(result) --|                            |
  |                            |                            |
```

**Message Router**

Центральный маршрутизатор, нормализующий входящие сообщения из разных источников и направляющий их в Core Engine.

```
+---------------------------------------------------------------------+
|                        Message Router                                |
|                                                                      |
|  +-----------------+    +-------------------+    +-----------------+ |
|  | Source          |    | Intent            |    | Priority        | |
|  | Normalizer      |--->| Classifier        |--->| Router          | |
|  |                 |    |                   |    |                 | |
|  | MAX -> unified  |    | command/question/ |    | urgent -> fast  | |
|  | API -> unified  |    | task/feedback     |    | normal -> queue | |
|  | WS  -> unified  |    |                   |    | batch -> async  | |
|  +-----------------+    +-------------------+    +-----------------+ |
+---------------------------------------------------------------------+
```

#### 2.2.3 Core Engine (OpenClaw)

**Task Orchestrator**

Оркестратор задач, реализующий выполнение сложных многошаговых заданий.

```
+---------------------------------------------------------------------+
|                       Task Orchestrator                              |
|                                                                      |
|  Входящая задача                                                     |
|       |                                                              |
|       v                                                              |
|  +----+-----+     +-----------+     +------------+                  |
|  | Task     |     | Dependency|     | Execution  |                  |
|  | Planner  +---->| Resolver  +---->| Engine     |                  |
|  |          |     |           |     |            |                  |
|  | Разбиение|     | Граф      |     | Параллельное|                 |
|  | на шаги  |     | зависим.  |     | исполнение |                  |
|  +----------+     +-----------+     +-----+------+                  |
|                                           |                          |
|                                     +-----v------+                  |
|                                     | Result     |                  |
|                                     | Aggregator |                  |
|                                     +------------+                  |
+---------------------------------------------------------------------+
```

Ключевые возможности:

- **DAG-based execution** -- задачи представлены как направленный ациклический граф
- **Параллельное исполнение** -- независимые подзадачи выполняются параллельно
- **Retry policy** -- автоматические повторные попытки с exponential backoff
- **Circuit breaker** -- защита от каскадных отказов
- **Dead letter queue** -- обработка необрабатываемых задач

**Agent Manager**

Управляет жизненным циклом агентов, включая локальных (Claude Code CLI) и удаленных (Cloud.ru AI Agents).

```
+---------------------------------------------------------------------+
|                        Agent Manager                                 |
|                                                                      |
|  +-------------------+     +-------------------+                    |
|  | Agent Registry    |     | Health Monitor    |                    |
|  |                   |     |                   |                    |
|  | name -> config    |     | Periodic checks   |                    |
|  | type -> provider  |     | Liveness probes   |                    |
|  | status -> health  |     | Auto-restart      |                    |
|  +-------------------+     +-------------------+                    |
|                                                                      |
|  +-------------------+     +-------------------+                    |
|  | Agent Pool        |     | Load Balancer     |                    |
|  |                   |     |                   |                    |
|  | Pre-warmed agents |     | Round-robin       |                    |
|  | Idle recycling    |     | Least-connections |                    |
|  | Auto-scaling      |     | Capability-based  |                    |
|  +-------------------+     +-------------------+                    |
+---------------------------------------------------------------------+
```

**Session Manager**

Управление состоянием пользовательских сессий и контекстом разговоров.

| Компонент            | Хранилище  | TTL           | Назначение                   |
| -------------------- | ---------- | ------------- | ---------------------------- |
| Active sessions      | Redis      | 30 мин (idle) | Текущие сессии пользователей |
| Conversation history | PostgreSQL | 90 дней       | Полная история диалогов      |
| Context window       | Redis      | Per-session   | Текущий контекст для LLM     |
| User preferences     | PostgreSQL | Бессрочно     | Настройки пользователей      |

#### 2.2.4 AI Infrastructure (Cloud.ru)

**Foundation Models API**

Cloud.ru предоставляет OpenAI-совместимый API для доступа к LLM.

| Параметр      | Описание                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint      | `https://api.cloud.ru/ai/v1/chat/completions`                                                                                                                                                 |
| Совместимость | OpenAI API v1 (drop-in replacement)                                                                                                                                                           |
| Модели        | GigaChat-2-Max, GLM-4.7, GLM-4.7-Flash, Qwen3-235B, Qwen3-Coder-480B, Qwen3-Coder-Next, DeepSeek-V3, DeepSeek-R1, DeepSeek-OCR-2, T-pro-it-2.1, T-lite-it-2.1, Mistral, LLaMA 3.3, MiniMax-M2 |
| Авторизация   | Bearer Token (Service Account)                                                                                                                                                                |
| Streaming     | SSE (Server-Sent Events)                                                                                                                                                                      |
| Rate Limits   | По тарифному плану                                                                                                                                                                            |

Пример запроса:

```bash
curl -X POST https://api.cloud.ru/ai/v1/chat/completions \
  -H "Authorization: Bearer ${CLOUDRU_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gigachat-pro",
    "messages": [
      {"role": "system", "content": "Ты AI-ассистент OpenClaw."},
      {"role": "user", "content": "Проанализируй этот код..."}
    ],
    "temperature": 0.7,
    "max_tokens": 4096,
    "stream": true
  }'
```

**AI Agents Service**

Управляемый сервис для создания и оркестрации AI-агентов.

```
+---------------------------------------------------------------------+
|                    Cloud.ru AI Agents Service                        |
|                                                                      |
|  API: POST /ai/v1/{projectId}/agents                                |
|                                                                      |
|  +------------------+    +------------------+    +-----------------+ |
|  | Agent Definition |    | Runtime          |    | Scaling         | |
|  |                  |    |                  |    |                 | |
|  | - name           |    | - instanceTypeId |    | - minInstances  | |
|  | - systemPrompt   |    | - modelSource    |    | - maxInstances  | |
|  | - mcpServerIds   |    | - status         |    | - scalingType   | |
|  | - ragBaseIds     |    | - agentUrl       |    | - idleTimeout   | |
|  +------------------+    +------------------+    +-----------------+ |
|                                                                      |
|  Lifecycle:  CREATING -> RUNNING -> STOPPED -> DELETING              |
|                  |          |                                        |
|                  +----------+--- ERROR                               |
+---------------------------------------------------------------------+
```

Ключевые API-операции:

| Операция        | Метод  | Endpoint                        |
| --------------- | ------ | ------------------------------- |
| Создать агента  | POST   | `/{projectId}/agents`           |
| Получить агента | GET    | `/{projectId}/agents/{agentId}` |
| Список агентов  | GET    | `/{projectId}/agents`           |
| Обновить агента | PATCH  | `/{projectId}/agents/{agentId}` |
| Удалить агента  | DELETE | `/{projectId}/agents/{agentId}` |
| Чат с агентом   | POST   | `{agentUrl}/sse` (SSE)          |

**MCP Servers (Model Context Protocol)**

Внешние инструменты, доступные агентам через стандартизированный протокол.

```
+---------------------------------------------------------------------+
|                      MCP Servers (Cloud.ru)                          |
|                                                                      |
|  +--------------+  +--------------+  +--------------+               |
|  | Web Search   |  | File System  |  | Code Exec    |               |
|  | MCP Server   |  | MCP Server   |  | MCP Server   |               |
|  |              |  |              |  |              |               |
|  | - Поиск в    |  | - Чтение     |  | - Python     |               |
|  |   интернете  |  | - Запись     |  | - Node.js    |               |
|  | - Индексация |  | - Листинг    |  | - Sandbox    |               |
|  +--------------+  +--------------+  +--------------+               |
|                                                                      |
|  +--------------+  +--------------+  +--------------+               |
|  | Database     |  | API Client   |  | Custom       |               |
|  | MCP Server   |  | MCP Server   |  | MCP Server   |               |
|  |              |  |              |  |              |               |
|  | - SQL queries|  | - REST calls |  | - Бизнес-    |               |
|  | - Migrations |  | - GraphQL    |  |   логика     |               |
|  | - Backup     |  | - gRPC       |  | - Плагины    |               |
|  +--------------+  +--------------+  +--------------+               |
+---------------------------------------------------------------------+
```

**Agent Systems (A2A Protocol)**

Мультиагентные системы для совместного решения сложных задач.

```
+---------------------------------------------------------------------+
|                    Agent System (A2A)                                 |
|                                                                      |
|                  +-------------------+                               |
|                  | Agent System      |                               |
|                  | Coordinator       |                               |
|                  +--------+----------+                               |
|                           |                                          |
|              +------------+------------+                             |
|              |            |            |                              |
|     +--------v---+ +-----v------+ +---v----------+                  |
|     | Planner    | | Coder      | | Reviewer     |                  |
|     | Agent      | | Agent      | | Agent        |                  |
|     |            | |            | |              |                  |
|     | Декомпозиц.| | Написание  | | Code review  |                  |
|     | задач      | | кода       | | и тесты      |                  |
|     +------------+ +------------+ +--------------+                  |
|                                                                      |
|  Protocol: A2A (Agent-to-Agent)                                     |
|  Communication: через Cloud.ru Agent Systems API                    |
|  Shared Context: RAG knowledge base                                 |
+---------------------------------------------------------------------+
```

API для Agent Systems:

| Операция                  | Метод  | Endpoint                                         |
| ------------------------- | ------ | ------------------------------------------------ |
| Создать систему           | POST   | `/{projectId}/agentSystems`                      |
| Добавить агента           | PATCH  | `/{projectId}/agentSystems/{systemId}/{agentId}` |
| Удалить агента из системы | DELETE | `/{projectId}/agentSystems/{systemId}/{agentId}` |
| Получить систему          | GET    | `/{projectId}/agentSystems/{systemId}`           |
| Удалить систему           | DELETE | `/{projectId}/agentSystems/{systemId}`           |

**Managed RAG**

Управляемый сервис Retrieval-Augmented Generation для подключения баз знаний к агентам.

| Параметр           | Описание                              |
| ------------------ | ------------------------------------- |
| Форматы документов | PDF, DOCX, TXT, Markdown, HTML        |
| Chunking           | Автоматическое разбиение на фрагменты |
| Embedding          | Встроенные модели векторизации        |
| Vector Search      | Семантический поиск по базе знаний    |
| API                | Привязка к агенту через `ragBaseIds`  |

---

## 3. Потоки данных

### 3.1 Пользовательский запрос через MAX Messenger

```
Пользователь            MAX Platform         OpenClaw Gateway         Core Engine           Cloud.ru
    |                       |                       |                       |                    |
    | 1. Сообщение в чат    |                       |                       |                    |
    |---------------------->|                       |                       |                    |
    |                       | 2. Webhook POST       |                       |                    |
    |                       |---------------------->|                       |                    |
    |                       |                       | 3. Verify signature   |                    |
    |                       |                       | 4. Normalize event    |                    |
    |                       |                       | 5. Route to engine    |                    |
    |                       |                       |---------------------->|                    |
    |                       |                       |                       | 6. Resolve session   |
    |                       |                       |                       | 7. Build context     |
    |                       |                       |                       | 8. Select agent      |
    |                       |                       |                       |                    |
    |                       |                       |                       | 9. LLM inference     |
    |                       |                       |                       |------------------->|
    |                       |                       |                       |                    |
    |                       |                       |                       |    10. If tools     |
    |                       |                       |                       |    needed: MCP call |
    |                       |                       |                       |<-------------------|
    |                       |                       |                       |------------------->|
    |                       |                       |                       |                    |
    |                       |                       |                       | 11. Aggregate       |
    |                       |                       |<----------------------|     result          |
    |                       |                       |                       |                    |
    |                       | 12. MAX Bot API       |                       |                    |
    |                       |   sendMessage()       |                       |                    |
    |                       |<----------------------|                       |                    |
    |                       |                       |                       |                    |
    | 13. Ответ в чате      |                       |                       |                    |
    |<----------------------|                       |                       |                    |
```

Детализация шагов:

1. Пользователь отправляет текстовое сообщение или нажимает inline-кнопку в MAX.
2. MAX Platform доставляет событие на webhook-endpoint OpenClaw (`POST /api/webhooks/max`).
3. Gateway верифицирует подпись запроса (HMAC) для защиты от подделки.
4. Событие MAX нормализуется в формат `OpenClawMessage`.
5. Message Router определяет intent (команда, вопрос, задача) и направляет в Core Engine.
6. Session Manager восстанавливает или создает сессию пользователя из Redis.
7. Формируется контекст: история диалога + системный промпт + данные из RAG.
8. Agent Manager выбирает подходящего агента на основе типа задачи.
9. Запрос отправляется в Cloud.ru Foundation Models API (streaming SSE).
10. Если модель запрашивает инструменты (function calling), выполняется вызов MCP-сервера.
11. Результат агрегируется и форматируется для отправки пользователю.
12. Ответ отправляется через MAX Bot API (`sendMessage` / `editMessage`).
13. Пользователь видит ответ в чате MAX.

### 3.2 Создание AI-агента через OpenClaw

```
Администратор        OpenClaw CLI         Agent Manager        Cloud.ru AI Agents
    |                     |                     |                       |
    | 1. openclaw agent   |                     |                       |
    |    create --config  |                     |                       |
    |-------------------->|                     |                       |
    |                     | 2. Validate config  |                       |
    |                     |-------------------->|                       |
    |                     |                     | 3. POST /{projectId}  |
    |                     |                     |    /agents             |
    |                     |                     |---------------------->|
    |                     |                     |                       |
    |                     |                     |    4. status:CREATING  |
    |                     |                     |<----------------------|
    |                     |                     |                       |
    |                     |                     | 5. Poll status         |
    |                     |                     |---------------------->|
    |                     |                     |    6. status:RUNNING   |
    |                     |                     |    agentUrl: https://  |
    |                     |                     |<----------------------|
    |                     |                     |                       |
    |                     | 7. Agent registered  |                       |
    |                     |<--------------------|                       |
    |                     |                     |                       |
    | 8. Agent ready      |                     |                       |
    |<--------------------|                     |                       |
```

Пример команды создания агента:

```bash
openclaw agent create \
  --name "code-reviewer" \
  --provider cloudru \
  --model "deepseek-coder-v2" \
  --system-prompt "Ты опытный code reviewer..." \
  --mcp-servers "web-search,code-exec" \
  --scaling-min 0 \
  --scaling-max 5 \
  --scaling-type concurrency
```

Соответствующий запрос к Cloud.ru API:

```json
{
  "name": "code-reviewer",
  "instanceTypeId": "gpu.a100.1",
  "modelSource": "foundation_models",
  "modelId": "deepseek-coder-v2",
  "systemPrompt": "Ты опытный code reviewer...",
  "mcpServerIds": ["mcp-web-search", "mcp-code-exec"],
  "scaling": {
    "minInstances": 0,
    "maxInstances": 5,
    "scalingType": "concurrency",
    "idleTimeout": 300
  }
}
```

### 3.3 Мультиагентное выполнение

```
Пользователь         OpenClaw              Cloud.ru Agent System        Агенты (Cloud.ru)
    |                   |                          |                          |
    | 1. Сложная задача |                          |                          |
    |------------------>|                          |                          |
    |                   |                          |                          |
    |                   | 2. POST /agentSystems    |                          |
    |                   |   {name, description}    |                          |
    |                   |------------------------->|                          |
    |                   |                          |                          |
    |                   | 3. PATCH /{systemId}/    |                          |
    |                   |    {plannerId}           |                          |
    |                   |------------------------->|                          |
    |                   |                          |                          |
    |                   | 4. PATCH /{systemId}/    |                          |
    |                   |    {coderId}             |                          |
    |                   |------------------------->|                          |
    |                   |                          |                          |
    |                   | 5. PATCH /{systemId}/    |                          |
    |                   |    {reviewerId}          |                          |
    |                   |------------------------->|                          |
    |                   |                          |                          |
    |                   | 6. Initiate task         |                          |
    |                   |------------------------->|                          |
    |                   |                          | 7. Координация агентов   |
    |                   |                          |------------------------->|
    |                   |                          |                          |
    |                   |                          |    Planner: декомпозиция |
    |                   |                          |<-------------------------|
    |                   |                          |                          |
    |                   |                          |    Coder: реализация     |
    |                   |                          |<-------------------------|
    |                   |                          |                          |
    |                   |                          |    Reviewer: проверка    |
    |                   |                          |<-------------------------|
    |                   |                          |                          |
    |                   | 8. Агрегированный        |                          |
    |                   |    результат             |                          |
    |                   |<-------------------------|                          |
    |                   |                          |                          |
    | 9. Результат      |                          |                          |
    |   (через MAX)     |                          |                          |
    |<------------------|                          |                          |
```

### 3.4 RAG-обогащенный запрос

```
Пользователь -> OpenClaw -> Cloud.ru Foundation Models API
                                |
                                | (function call: search_knowledge_base)
                                |
                                v
                         Cloud.ru Managed RAG
                                |
                                | (релевантные фрагменты документов)
                                |
                                v
                      Foundation Models API
                                |
                                | (ответ, обогащенный контекстом из RAG)
                                |
                                v
                           OpenClaw -> Пользователь (через MAX)
```

---

## 4. Интеграционные паттерны

### 4.1 MAX Bot <-> OpenClaw

#### 4.1.1 Event-driven Architecture

MAX Bot использует событийную модель для обработки входящих сообщений.

```typescript
// Обработка событий MAX Messenger
import { Bot, MessageEvent, CallbackEvent } from "@maxhub/max-bot-api";

const bot = new Bot({ token: process.env.MAX_BOT_TOKEN });

// Обработка текстовых сообщений
bot.on("message_created", async (event: MessageEvent) => {
  const message = normalizeMaxEvent(event);
  await messageRouter.route(message);
});

// Обработка callback от inline-кнопок
bot.on("message_callback", async (event: CallbackEvent) => {
  const callback = normalizeCallback(event);
  await callbackRouter.route(callback);
});

// Обработка редактирования сообщений
bot.on("message_edited", async (event: MessageEvent) => {
  const message = normalizeMaxEvent(event);
  await messageRouter.routeEdit(message);
});

// Событие запуска бота (добавление в чат)
bot.on("bot_started", async (event: BotStartedEvent) => {
  await sendWelcomeMessage(event.chatId);
});
```

#### 4.1.2 State Management

Управление состоянием пользователя через Redis.

```typescript
interface UserSession {
  userId: string;
  chatId: string; // MAX chat ID
  state: SessionState; // 'idle' | 'awaiting_input' | 'processing'
  currentTaskId?: string; // Active task reference
  conversationHistory: Message[];
  contextWindow: Message[]; // Last N messages for LLM context
  preferences: UserPreferences;
  lastActivity: Date;
  ttl: number; // Session TTL in seconds
}

// Пример управления состоянием
class SessionStore {
  private redis: Redis;

  async getOrCreate(userId: string, chatId: string): Promise<UserSession> {
    const key = `session:${userId}:${chatId}`;
    let session = await this.redis.get(key);
    if (!session) {
      session = this.createNewSession(userId, chatId);
      await this.redis.setex(key, 1800, JSON.stringify(session));
    }
    return JSON.parse(session);
  }

  async update(session: UserSession): Promise<void> {
    const key = `session:${session.userId}:${session.chatId}`;
    await this.redis.setex(key, 1800, JSON.stringify(session));
  }
}
```

#### 4.1.3 Command Routing

Маршрутизация пользовательских команд.

| Команда                | Описание                                 | Обработчик        |
| ---------------------- | ---------------------------------------- | ----------------- |
| `/start`               | Приветственное сообщение и инициализация | `WelcomeHandler`  |
| `/help`                | Справка по доступным командам            | `HelpHandler`     |
| `/task <описание>`     | Создание новой задачи для AI             | `TaskHandler`     |
| `/agent list`          | Список доступных агентов                 | `AgentHandler`    |
| `/agent create <name>` | Создание нового агента                   | `AgentHandler`    |
| `/status`              | Статус текущей задачи                    | `StatusHandler`   |
| `/history`             | История выполненных задач                | `HistoryHandler`  |
| `/settings`            | Настройки пользователя                   | `SettingsHandler` |
| `/cancel`              | Отмена текущей задачи                    | `CancelHandler`   |

#### 4.1.4 UI-взаимодействие через Inline Keyboards

```typescript
// Пример inline keyboard для выбора агента
function buildAgentSelectionKeyboard(agents: Agent[]): InlineKeyboardMarkup {
  return {
    buttons: agents
      .map((agent) => [
        {
          type: "callback",
          text: `${agent.name} (${agent.provider})`,
          payload: `select_agent:${agent.id}`,
        },
      ])
      .concat([
        [
          {
            type: "callback",
            text: "Отмена",
            payload: "cancel_selection",
          },
        ],
      ]),
  };
}

// Пример индикатора прогресса задачи
async function sendProgressUpdate(
  chatId: string,
  taskId: string,
  progress: number,
  messageId?: string,
): Promise<void> {
  const bar = buildProgressBar(progress); // [=========>    ] 67%
  const text = `Задача \`${taskId}\`\n${bar}\nСтатус: выполняется...`;

  if (messageId) {
    await bot.editMessage(chatId, messageId, { text, format: "markdown" });
  } else {
    await bot.sendMessage(chatId, { text, format: "markdown" });
  }
}
```

### 4.2 OpenClaw <-> Cloud.ru API

#### 4.2.1 Аутентификация и авторизация

Cloud.ru использует Service Account механизм для API-доступа.

```
+---------------------------------------------------------------------+
|                 Процесс аутентификации Cloud.ru                      |
|                                                                      |
|  1. Создание Service Account в Cloud.ru Console                     |
|  2. Генерация API Key (secret)                                      |
|  3. Обмен API Key на Bearer Token                                   |
|                                                                      |
|  POST https://auth.cloud.ru/api/v1/auth/token                      |
|  {                                                                   |
|    "apiKey": "sk-..."                                               |
|  }                                                                   |
|  ->                                                                  |
|  {                                                                   |
|    "token": "eyJ...",                                               |
|    "expiresAt": "2026-05-13T00:00:00Z"                              |
|  }                                                                   |
|                                                                      |
|  4. Использование Bearer Token в запросах:                          |
|     Authorization: Bearer eyJ...                                    |
+---------------------------------------------------------------------+
```

Реализация в OpenClaw:

```typescript
class CloudRuAuthProvider {
  private token: string | null = null;
  private expiresAt: Date | null = null;

  constructor(
    private apiKey: string, // Из secrets manager, НИКОГДА из кода
    private authUrl: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && this.expiresAt && this.expiresAt > new Date()) {
      return this.token;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    const response = await fetch(`${this.authUrl}/api/v1/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: this.apiKey }),
    });

    if (!response.ok) {
      throw new CloudRuAuthError(`Auth failed: ${response.status}`);
    }

    const data = await response.json();
    this.token = data.token;
    this.expiresAt = new Date(data.expiresAt);

    return this.token;
  }
}
```

#### 4.2.2 Token Management

| Параметр              | Рекомендация                         |
| --------------------- | ------------------------------------ |
| TTL API Key           | До 1 года (максимум Cloud.ru)        |
| Рекомендуемая ротация | Каждые 90 дней                       |
| Хранение              | HashiCorp Vault / K8s Secrets        |
| Мониторинг            | Alerting за 14 дней до истечения     |
| Резервный ключ        | Всегда поддерживать 2 активных ключа |

#### 4.2.3 Retry Policy и Error Handling

```typescript
interface RetryConfig {
  maxRetries: number; // 3
  baseDelay: number; // 1000ms
  maxDelay: number; // 30000ms
  backoffMultiplier: number; // 2
  retryableStatuses: number[]; // [429, 500, 502, 503, 504]
}

class CloudRuClient {
  private retryConfig: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
  };

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const token = await this.auth.getToken();
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          return await response.json();
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : this.calculateDelay(attempt);
          await this.sleep(delay);
          continue;
        }

        if (this.retryConfig.retryableStatuses.includes(response.status)) {
          await this.sleep(this.calculateDelay(attempt));
          continue;
        }

        throw new CloudRuApiError(response.status, await response.text());
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.retryConfig.maxRetries) {
          await this.sleep(this.calculateDelay(attempt));
        }
      }
    }

    throw lastError!;
  }

  private calculateDelay(attempt: number): number {
    const delay =
      this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt);
    const jitter = Math.random() * 0.3 * delay; // 30% jitter
    return Math.min(delay + jitter, this.retryConfig.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

#### 4.2.4 Connection Pooling

```typescript
import { Agent as HttpAgent } from "undici";

const connectionPool = new HttpAgent({
  connections: 50, // Максимум параллельных соединений
  pipelining: 1, // HTTP pipelining
  keepAliveTimeout: 30000, // Keep-alive таймаут
  keepAliveMaxTimeout: 600000,
  connect: {
    timeout: 10000, // Таймаут подключения
    rejectUnauthorized: true, // Строгая проверка TLS
  },
});
```

### 4.3 MCP Integration

#### 4.3.1 OpenClaw как MCP Client

OpenClaw выступает клиентом MCP-серверов, размещенных в Cloud.ru.

```
+---------------------------------------------------------------------+
|                      MCP Integration Flow                            |
|                                                                      |
|  OpenClaw                       Cloud.ru                             |
|  (MCP Client)                   (MCP Servers)                        |
|                                                                      |
|  1. Agent needs tool            |                                    |
|     |                           |                                    |
|  2. Resolve MCP Server ID       |                                    |
|     |                           |                                    |
|  3. MCP Request ------------>   |                                    |
|     {                           |                                    |
|       "method": "tools/call",   |                                    |
|       "params": {               |                                    |
|         "name": "web_search",   |                                    |
|         "arguments": {          |                                    |
|           "query": "..."        |                                    |
|         }                       |                                    |
|       }                         |                                    |
|     }                           |                                    |
|                                 |  4. Execute tool                   |
|                                 |  5. Return result                  |
|     <------------------------   |                                    |
|     {                           |                                    |
|       "content": [{             |                                    |
|         "type": "text",         |                                    |
|         "text": "..."           |                                    |
|       }]                        |                                    |
|     }                           |                                    |
|                                 |                                    |
|  6. Feed result to LLM         |                                    |
+---------------------------------------------------------------------+
```

#### 4.3.2 Custom MCP Servers

OpenClaw может регистрировать собственные MCP-серверы для предоставления доступа к внутренним инструментам.

```typescript
// Пример регистрации custom MCP server в Cloud.ru
const mcpServerConfig = {
  name: "openclaw-tools",
  description: "OpenClaw internal tools",
  transport: "sse",
  url: "https://openclaw.example.com/mcp/sse",
  tools: [
    {
      name: "create_task",
      description: "Создать задачу в OpenClaw",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["title"],
      },
    },
    {
      name: "query_knowledge_base",
      description: "Поиск в базе знаний OpenClaw",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 5 },
        },
        required: ["query"],
      },
    },
  ],
};
```

---

## 5. Модели данных

### 5.1 Unified Message Format

Единый формат сообщения, абстрагирующий различные источники входящих данных.

```typescript
/**
 * Унифицированное сообщение OpenClaw.
 * Все входящие сообщения (MAX, REST API, WebSocket) нормализуются в этот формат.
 */
interface OpenClawMessage {
  /** Уникальный идентификатор сообщения (UUID v7) */
  id: string;

  /** Источник сообщения */
  source: "max" | "api" | "websocket";

  /** Идентификатор пользователя в OpenClaw */
  userId: string;

  /** Идентификатор сессии */
  sessionId: string;

  /** Текстовое содержимое сообщения */
  content: string;

  /** Тип сообщения */
  type: "command" | "text" | "callback" | "file";

  /** Метаданные, специфичные для источника */
  metadata: {
    /** MAX Messenger: идентификатор чата */
    maxChatId?: string;
    /** MAX Messenger: идентификатор сообщения */
    maxMessageId?: string;
    /** MAX Messenger: тип чата (dialog/chat/channel) */
    maxChatType?: "dialog" | "chat" | "channel";
    /** Формат содержимого */
    format?: "text" | "markdown" | "html";
    /** Приложенные файлы */
    attachments?: FileAttachment[];
    /** Callback data (для inline кнопок) */
    callbackData?: string;
  };

  /** Время создания сообщения */
  timestamp: Date;

  /** Время получения OpenClaw */
  receivedAt: Date;
}

interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}
```

### 5.2 Agent Configuration

```typescript
/**
 * Конфигурация агента в OpenClaw.
 * Поддерживает как локальных (Claude Code CLI), так и удаленных (Cloud.ru) агентов.
 */
interface AgentConfig {
  /** Уникальное имя агента */
  name: string;

  /** Описание назначения агента */
  description?: string;

  /** Провайдер выполнения */
  provider: "cloudru" | "local";

  /** Роль агента в системе */
  role: "coder" | "reviewer" | "planner" | "researcher" | "analyst" | "custom";

  /** Конфигурация для Cloud.ru провайдера */
  cloudru?: {
    /** ID проекта в Cloud.ru */
    projectId: string;
    /** Тип инстанса (GPU) */
    instanceTypeId: string;
    /** Источник модели */
    modelSource: "foundation_models" | "ml_inference";
    /** ID конкретной модели */
    modelId?: string;
    /** Системный промпт агента */
    systemPrompt: string;
    /** Список подключенных MCP-серверов */
    mcpServerIds?: string[];
    /** Список подключенных баз знаний (RAG) */
    ragBaseIds?: string[];
    /** Настройки масштабирования */
    scaling: {
      /** Минимальное количество инстансов (0 = serverless) */
      minInstances: number;
      /** Максимальное количество инстансов */
      maxInstances: number;
      /** Тип масштабирования */
      scalingType: "rps" | "concurrency";
      /** Таймаут бездействия до scale-down (секунды) */
      idleTimeout?: number;
    };
    /** Параметры генерации LLM */
    generationParams?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      topK?: number;
      stopSequences?: string[];
    };
  };

  /** Конфигурация для локального провайдера */
  local?: {
    /** Команда запуска */
    command: string;
    /** Рабочая директория */
    workDir: string;
    /** Переменные окружения */
    env?: Record<string, string>;
    /** Таймаут выполнения (мс) */
    timeout?: number;
  };
}
```

### 5.3 Task Model

```typescript
/**
 * Модель задачи в OpenClaw.
 */
interface Task {
  /** Уникальный идентификатор задачи (UUID v7) */
  id: string;

  /** Заголовок задачи */
  title: string;

  /** Подробное описание */
  description: string;

  /** Текущий статус */
  status: TaskStatus;

  /** Приоритет */
  priority: "low" | "medium" | "high" | "critical";

  /** ID пользователя, создавшего задачу */
  createdBy: string;

  /** ID сессии, в рамках которой создана задача */
  sessionId: string;

  /** Список подзадач (для сложных задач) */
  subtasks: SubTask[];

  /** Назначенные агенты */
  assignedAgents: string[];

  /** Результат выполнения */
  result?: TaskResult;

  /** Метаданные выполнения */
  execution: {
    startedAt?: Date;
    completedAt?: Date;
    duration?: number; // миллисекунды
    tokensUsed?: number; // общее количество токенов LLM
    toolCalls?: number; // количество вызовов инструментов
    retries?: number; // количество повторных попыток
  };

  /** Время создания */
  createdAt: Date;

  /** Время последнего обновления */
  updatedAt: Date;
}

type TaskStatus =
  | "pending" // Ожидает выполнения
  | "planning" // Этап планирования (декомпозиция)
  | "in_progress" // Выполняется
  | "awaiting_input" // Ожидает ввода пользователя
  | "completed" // Завершена успешно
  | "failed" // Завершена с ошибкой
  | "cancelled"; // Отменена пользователем

interface SubTask {
  id: string;
  parentId: string;
  title: string;
  status: TaskStatus;
  agentId?: string;
  dependencies: string[]; // IDs подзадач-зависимостей
  result?: TaskResult;
}

interface TaskResult {
  success: boolean;
  output: string;
  artifacts?: Artifact[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface Artifact {
  type: "code" | "document" | "image" | "data";
  name: string;
  content: string;
  mimeType: string;
}
```

### 5.4 Cloud.ru Agent State Mapping

Маппинг статусов между Cloud.ru и OpenClaw:

| Cloud.ru Status | OpenClaw Status | Описание                               |
| --------------- | --------------- | -------------------------------------- |
| `CREATING`      | `provisioning`  | Агент создается в Cloud.ru             |
| `RUNNING`       | `ready`         | Агент готов к работе                   |
| `STOPPED`       | `stopped`       | Агент остановлен (ресурсы не выделены) |
| `ERROR`         | `error`         | Ошибка при создании или работе         |
| `DELETING`      | `terminating`   | Агент удаляется                        |
| (not created)   | `local`         | Локальный агент (не в Cloud.ru)        |

### 5.5 Event Schema

```typescript
/**
 * Базовая схема событий OpenClaw (Event Sourcing).
 */
interface DomainEvent {
  eventId: string; // UUID v7
  eventType: string; // Тип события
  aggregateId: string; // ID агрегата
  aggregateType: string; // Тип агрегата
  payload: unknown; // Данные события
  metadata: {
    userId?: string;
    sessionId?: string;
    source: string;
    correlationId: string;
    causationId?: string;
    timestamp: Date;
    version: number;
  };
}

// Примеры событий
type EventTypes =
  | "TaskCreated"
  | "TaskStarted"
  | "TaskCompleted"
  | "TaskFailed"
  | "AgentSpawned"
  | "AgentHealthCheckFailed"
  | "AgentTerminated"
  | "SessionStarted"
  | "SessionEnded"
  | "MessageReceived"
  | "MessageSent"
  | "ToolCallExecuted"
  | "LLMInferenceCompleted";
```

---

## 6. Безопасность

### 6.1 Обзор уровней безопасности

```
+---------------------------------------------------------------------+
|                     Уровни безопасности системы                      |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  | Level 1: Сетевой уровень                                     |  |
|  | - TLS 1.3 для всех коммуникаций                              |  |
|  | - VPN/Private Network между компонентами                      |  |
|  | - WAF на Gateway                                             |  |
|  | - DDoS protection                                            |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  | Level 2: Аутентификация и авторизация                        |  |
|  | - MAX: верификация через Госуслуги                            |  |
|  | - API: Bearer Token + API Key                                |  |
|  | - Cloud.ru: Service Account + scoped tokens                  |  |
|  | - RBAC: роли admin/user/viewer                               |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  | Level 3: Защита данных                                       |  |
|  | - Хранение данных на территории РФ (Cloud.ru)                |  |
|  | - Encryption at rest (AES-256)                               |  |
|  | - Encryption in transit (TLS 1.3)                            |  |
|  | - PII masking в логах                                        |  |
|  +---------------------------------------------------------------+  |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  | Level 4: Комплаенс                                           |  |
|  | - ФЗ-152 (персональные данные)                               |  |
|  | - ФСТЭК (сертификация Cloud.ru)                             |  |
|  | - ГОСТ Р 57580 (информационная безопасность)                 |  |
|  +---------------------------------------------------------------+  |
+---------------------------------------------------------------------+
```

### 6.2 Аутентификация

#### MAX Messenger

- Пользователи верифицируются через Госуслуги (ЕСИА) при регистрации в MAX.
- Bot API использует токен бота для идентификации.
- Webhook-запросы от MAX верифицируются через HMAC-подпись.

```typescript
// Верификация webhook от MAX
function verifyMaxWebhook(body: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

#### Cloud.ru API

- Service Account с API Key для машинного доступа.
- Bearer Token с ограниченным TTL.
- Scoped permissions: доступ только к необходимым ресурсам.

#### OpenClaw API

- JWT-токены для пользователей.
- API Key для сервисных интеграций.
- OAuth 2.0 для третьесторонних приложений.

### 6.3 Секреты и ключи

| Секрет                | Хранилище          | Ротация                     |
| --------------------- | ------------------ | --------------------------- |
| MAX Bot Token         | Vault / K8s Secret | При компрометации           |
| Cloud.ru API Key      | Vault / K8s Secret | Каждые 90 дней              |
| Cloud.ru Bearer Token | In-memory cache    | Автоматически при истечении |
| Database credentials  | Vault              | Каждые 30 дней              |
| JWT signing key       | Vault              | Каждые 180 дней             |
| Webhook secret        | Vault / K8s Secret | При компрометации           |

**Правила обращения с секретами:**

- НИКОГДА не хранить секреты в исходном коде или конфигурационных файлах.
- НИКОГДА не коммитить `.env` файлы в репозиторий.
- Использовать HashiCorp Vault или Kubernetes Secrets для хранения.
- Все секреты передаются через переменные окружения.
- Логирование маскирует любые значения, похожие на токены/ключи.

### 6.4 Input Validation

```typescript
// Валидация на уровне Gateway
import { z } from "zod";

const MessageSchema = z.object({
  content: z.string().min(1).max(10000).transform(sanitizeHtml),
  attachments: z
    .array(
      z.object({
        name: z
          .string()
          .max(255)
          .regex(/^[a-zA-Z0-9._-]+$/),
        mimeType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
        size: z.number().max(50 * 1024 * 1024), // 50MB max
      }),
    )
    .max(10)
    .optional(),
});

// Защита от directory traversal
function sanitizePath(userInput: string): string {
  const normalized = path.normalize(userInput);
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new SecurityError("Invalid path: directory traversal detected");
  }
  return normalized;
}

// Rate limiting на уровне пользователя
const rateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 минута
  maxRequests: 30, // 30 запросов в минуту
  keyGenerator: (req) => req.userId,
});
```

### 6.5 Соответствие ФЗ-152

| Требование            | Реализация                            |
| --------------------- | ------------------------------------- |
| Хранение данных в РФ  | Cloud.ru -- российские дата-центры    |
| Согласие на обработку | При первом взаимодействии с ботом     |
| Право на удаление     | Команда `/delete_my_data`             |
| Минимизация данных    | Хранение только необходимого минимума |
| Логирование доступа   | Аудит-лог всех операций с ПДн         |
| Уведомление об утечке | Автоматический alerting + процедура   |

---

## 7. Масштабирование

### 7.1 Архитектура масштабирования

```
+---------------------------------------------------------------------+
|                    Стратегия масштабирования                         |
|                                                                      |
|  +-----------------------+    +-----------------------------------+ |
|  | Horizontal Scaling    |    | Vertical Scaling                  | |
|  |                       |    |                                   | |
|  | MAX Bot Handler:      |    | Cloud.ru Foundation Models:       | |
|  |   PM2 Cluster Mode    |    |   Managed by Cloud.ru             | |
|  |   2-8 workers         |    |   (автоматическое масштабирование)| |
|  |                       |    |                                   | |
|  | OpenClaw Gateway:     |    | PostgreSQL:                       | |
|  |   K8s HPA             |    |   Read replicas                   | |
|  |   2-20 pods           |    |   Connection pooling (PgBouncer)  | |
|  |                       |    |                                   | |
|  | Core Engine:          |    | Redis:                            | |
|  |   K8s HPA             |    |   Redis Cluster (6 nodes)         | |
|  |   2-10 pods           |    |   Sentinel for HA                 | |
|  +-----------------------+    +-----------------------------------+ |
|                                                                      |
|  +-----------------------+    +-----------------------------------+ |
|  | Serverless Scaling    |    | Queue-based Scaling               | |
|  |                       |    |                                   | |
|  | Cloud.ru AI Agents:   |    | Task Queue (BullMQ):             | |
|  |   0 -> N instances    |    |   Workers scale with queue depth  | |
|  |   Scale on concurrency|    |   Priority queues                 | |
|  |   Idle timeout: 300s  |    |   Dead letter queue               | |
|  |                       |    |                                   | |
|  +-----------------------+    +-----------------------------------+ |
+---------------------------------------------------------------------+
```

### 7.2 Компонентное масштабирование

#### MAX Bot Handler

```yaml
# PM2 ecosystem config для MAX Bot
apps:
  - name: max-bot-handler
    script: dist/max-bot-handler.js
    instances: "max" # По количеству CPU
    exec_mode: cluster
    max_memory_restart: "512M"
    env:
      NODE_ENV: production
      MAX_BOT_TOKEN: "${MAX_BOT_TOKEN}"
```

| Параметр               | Значение                     |
| ---------------------- | ---------------------------- |
| Модель масштабирования | PM2 Cluster Mode             |
| Количество воркеров    | По числу CPU (2-8)           |
| Memory limit           | 512MB на воркер              |
| Sticky sessions        | Не требуется (stateless)     |
| Rate limit             | 30 RPS (ограничение MAX API) |

#### OpenClaw Gateway (Kubernetes)

```yaml
# Kubernetes HPA для Gateway
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: openclaw-gateway-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: openclaw-gateway
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
```

#### Cloud.ru AI Agents (Serverless)

```
Нагрузка:    [__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__|__]
              00  01  02  03  04  05  06  07  08  09  10  11  12  13  14  15  16  17

Инстансы:    0   0   0   0   0   0   1   2   5   5   3   5   5   5   5   3   2   1
              zzz zzz zzz zzz zzz zzz                                           zzz

              Ночью: 0 инстансов       Пик: до 5 инстансов      Вечер: снижение
              (serverless, $0)         (auto-scale)             (scale-down)
```

| Параметр       | Значение                        |
| -------------- | ------------------------------- |
| Min instances  | 0 (serverless)                  |
| Max instances  | 5-20 (по тарифу)                |
| Scaling metric | Concurrency / RPS               |
| Scale-up time  | 10-30 секунд (cold start)       |
| Idle timeout   | 300 секунд                      |
| Cost model     | Оплата только за активное время |

### 7.3 Пропускная способность

Расчет максимальной пропускной способности системы:

| Компонент          | Throughput (RPS) | Bottleneck           |
| ------------------ | ---------------- | -------------------- |
| MAX Bot API        | 30 RPS           | Platform rate limit  |
| OpenClaw Gateway   | 500 RPS          | K8s scaling          |
| Message Router     | 1000 RPS         | In-memory processing |
| Task Orchestrator  | 100 RPS          | Queue depth          |
| Cloud.ru LLM API   | 50 RPS           | Token processing     |
| Cloud.ru AI Agents | 20-100 RPS       | Instance count       |

**Bottleneck analysis:** Основное ограничение -- MAX Bot API (30 RPS на бота). Для повышения пропускной способности рекомендуется:

1. Несколько ботов с балансировкой нагрузки.
2. Использование Mini App для высоконагруженных сценариев.
3. Асинхронная обработка длительных задач с уведомлением.

---

## 8. Мониторинг и observability

### 8.1 Трехуровневая модель наблюдаемости

```
+---------------------------------------------------------------------+
|                    Observability Stack                                |
|                                                                      |
|  +-------------------+  +-------------------+  +------------------+ |
|  | Metrics           |  | Logs              |  | Traces           | |
|  | (Prometheus)      |  | (ELK/Loki)        |  | (Jaeger/Tempo)   | |
|  |                   |  |                   |  |                  | |
|  | - Request rate    |  | - Structured JSON |  | - Distributed    | |
|  | - Latency p50/99  |  | - Correlation IDs |  |   tracing        | |
|  | - Error rate      |  | - PII masking     |  | - Span context   | |
|  | - Queue depth     |  | - Log levels      |  | - Cross-service  | |
|  | - Token usage     |  | - Retention: 30d  |  | - Sampling: 10%  | |
|  +-------------------+  +-------------------+  +------------------+ |
|                                                                      |
|  +---------------------------------------------------------------+  |
|  | Dashboards & Alerting (Grafana)                               |  |
|  |                                                               |  |
|  | - System health overview                                      |  |
|  | - Agent performance                                           |  |
|  | - User activity                                               |  |
|  | - Cost tracking                                               |  |
|  | - SLA compliance                                              |  |
|  +---------------------------------------------------------------+  |
+---------------------------------------------------------------------+
```

### 8.2 Ключевые метрики

#### Бизнес-метрики

| Метрика                          | Описание                     | Threshold      |
| -------------------------------- | ---------------------------- | -------------- |
| `openclaw_tasks_created_total`   | Количество созданных задач   | Информационная |
| `openclaw_tasks_completed_total` | Количество завершенных задач | Информационная |
| `openclaw_tasks_failed_total`    | Количество неуспешных задач  | Alert: > 10%   |
| `openclaw_active_users`          | Активные пользователи        | Информационная |
| `openclaw_agent_utilization`     | Загрузка агентов             | Alert: > 90%   |

#### Технические метрики

| Метрика                                  | Описание                    | Threshold         |
| ---------------------------------------- | --------------------------- | ----------------- |
| `openclaw_http_requests_total`           | HTTP-запросы по endpoint    | Информационная    |
| `openclaw_http_request_duration_seconds` | Время ответа                | Alert: p99 > 5s   |
| `openclaw_gateway_errors_total`          | Ошибки на Gateway           | Alert: > 1%       |
| `openclaw_cloudru_api_latency_seconds`   | Время ответа Cloud.ru API   | Alert: p99 > 10s  |
| `openclaw_cloudru_token_expiry_seconds`  | Время до истечения токена   | Alert: < 14 дней  |
| `openclaw_max_webhook_delivery_errors`   | Ошибки доставки webhook MAX | Alert: > 5/мин    |
| `openclaw_redis_connections`             | Активные соединения Redis   | Alert: > 80% pool |
| `openclaw_queue_depth`                   | Глубина очереди задач       | Alert: > 1000     |
| `openclaw_llm_tokens_used_total`         | Использование токенов LLM   | Alert: > budget   |

#### Cloud.ru-специфичные метрики

| Метрика                             | Описание                    | Threshold        |
| ----------------------------------- | --------------------------- | ---------------- |
| `cloudru_agent_status`              | Статус агентов              | Alert: ERROR     |
| `cloudru_agent_cold_starts_total`   | Количество холодных стартов | Информационная   |
| `cloudru_foundation_models_latency` | Время inference LLM         | Alert: p99 > 15s |
| `cloudru_rate_limit_hits_total`     | Попадания в rate limit      | Alert: > 10/мин  |

### 8.3 Structured Logging

```typescript
// Пример structured logging
import { Logger } from "./logger";

const logger = new Logger({
  service: "openclaw-gateway",
  environment: process.env.NODE_ENV,
  piiMasking: true,
});

// Обработка входящего сообщения MAX
logger.info("max_message_received", {
  correlationId: message.id,
  userId: maskPII(message.userId),
  chatId: message.metadata.maxChatId,
  messageType: message.type,
  contentLength: message.content.length,
  source: "max",
});

// Вызов Cloud.ru API
logger.info("cloudru_api_call", {
  correlationId: task.id,
  endpoint: "/v1/chat/completions",
  model: "gigachat-pro",
  tokensInput: usage.promptTokens,
  tokensOutput: usage.completionTokens,
  latencyMs: duration,
  status: "success",
});

// Ошибка агента
logger.error("agent_execution_failed", {
  correlationId: task.id,
  agentId: agent.id,
  agentProvider: agent.provider,
  errorCode: error.code,
  errorMessage: error.message,
  retryAttempt: attempt,
  willRetry: attempt < maxRetries,
});
```

### 8.4 Alerting Rules

```yaml
# Prometheus alerting rules
groups:
  - name: openclaw-critical
    rules:
      - alert: HighErrorRate
        expr: |
          rate(openclaw_http_requests_total{status=~"5.."}[5m])
          / rate(openclaw_http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate exceeds 5%"

      - alert: CloudRuTokenExpiring
        expr: openclaw_cloudru_token_expiry_seconds < 1209600
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Cloud.ru token expires in less than 14 days"

      - alert: AgentDown
        expr: cloudru_agent_status{status="ERROR"} > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Cloud.ru agent in ERROR state"

      - alert: MAXWebhookFailures
        expr: rate(openclaw_max_webhook_delivery_errors[5m]) > 0.08
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "MAX webhook delivery errors increasing"

      - alert: HighQueueDepth
        expr: openclaw_queue_depth > 1000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Task queue depth exceeds 1000"

      - alert: LLMBudgetThreshold
        expr: openclaw_llm_tokens_used_total > 1000000
        labels:
          severity: warning
        annotations:
          summary: "LLM token usage approaching budget limit"
```

### 8.5 Health Check Endpoints

```typescript
// Health check для всех зависимостей
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: {
    redis: ComponentHealth;
    postgres: ComponentHealth;
    cloudru_api: ComponentHealth;
    cloudru_agents: ComponentHealth;
    max_bot_api: ComponentHealth;
    task_queue: ComponentHealth;
  };
  uptime: number;
  version: string;
}

// GET /api/v1/health
// Response:
{
  "status": "healthy",
  "components": {
    "redis": { "status": "healthy", "latencyMs": 2 },
    "postgres": { "status": "healthy", "latencyMs": 5 },
    "cloudru_api": { "status": "healthy", "latencyMs": 150 },
    "cloudru_agents": { "status": "healthy", "activeAgents": 3 },
    "max_bot_api": { "status": "healthy", "latencyMs": 80 },
    "task_queue": { "status": "healthy", "depth": 12 }
  },
  "uptime": 86400,
  "version": "1.0.0"
}
```

---

## 9. Стоимость и оптимизация

### 9.1 Структура затрат

```
+---------------------------------------------------------------------+
|                      Структура затрат                                 |
|                                                                      |
|  +-----------------------------+-----------------------------------+ |
|  | Компонент                   | Модель оплаты                    | |
|  +-----------------------------+-----------------------------------+ |
|  | Cloud.ru Foundation Models  | Pay-per-token                    | |
|  |   - Input tokens            |   ~0.001-0.005 руб/1K tokens     | |
|  |   - Output tokens           |   ~0.002-0.015 руб/1K tokens     | |
|  +-----------------------------+-----------------------------------+ |
|  | Cloud.ru AI Agents          | Serverless / Reserved            | |
|  |   - Serverless              |   Оплата за время работы         | |
|  |   - Reserved                |   Фиксированная стоимость/мес    | |
|  +-----------------------------+-----------------------------------+ |
|  | Cloud.ru Managed RAG        | По объему хранимых данных        | |
|  |   - Storage                 |   руб/ГБ/мес                     | |
|  |   - Queries                 |   руб/1K запросов                | |
|  +-----------------------------+-----------------------------------+ |
|  | MAX Bot                     | Бесплатно                        | |
|  |   - API usage               |   Rate limit: 30 RPS             | |
|  |   - Mini Apps               |   Бесплатно                      | |
|  +-----------------------------+-----------------------------------+ |
|  | Инфраструктура OpenClaw     | Cloud/On-premise                 | |
|  |   - Kubernetes cluster      |   По потреблению ресурсов        | |
|  |   - Redis                   |   По RAM                         | |
|  |   - PostgreSQL              |   По хранилищу + compute         | |
|  +-----------------------------+-----------------------------------+ |
+---------------------------------------------------------------------+
```

### 9.2 Оценка стоимости (помесячно)

| Компонент           | Low (< 1K users) | Medium (1K-10K)  | High (10K-100K)  |
| ------------------- | ---------------- | ---------------- | ---------------- |
| Cloud.ru LLM tokens | 5,000 руб        | 50,000 руб       | 500,000 руб      |
| Cloud.ru AI Agents  | 3,000 руб        | 30,000 руб       | 200,000 руб      |
| Cloud.ru RAG        | 1,000 руб        | 5,000 руб        | 30,000 руб       |
| K8s cluster         | 10,000 руб       | 30,000 руб       | 100,000 руб      |
| Redis + PostgreSQL  | 3,000 руб        | 10,000 руб       | 50,000 руб       |
| MAX Bot             | 0 руб            | 0 руб            | 0 руб            |
| **Итого**           | **~22,000 руб**  | **~125,000 руб** | **~880,000 руб** |

### 9.3 Стратегии оптимизации затрат

#### Кэширование ответов LLM

```typescript
class LLMResponseCache {
  private redis: Redis;
  private ttl: number = 3600; // 1 час

  async getCachedResponse(messages: Message[], model: string): Promise<string | null> {
    const key = this.buildCacheKey(messages, model);
    return this.redis.get(key);
  }

  async cacheResponse(messages: Message[], model: string, response: string): Promise<void> {
    const key = this.buildCacheKey(messages, model);
    await this.redis.setex(key, this.ttl, response);
  }

  private buildCacheKey(messages: Message[], model: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify({ messages, model }));
    return `llm:cache:${hash.digest("hex")}`;
  }
}
```

#### Prompt Compression

Сжатие промптов для уменьшения количества токенов:

| Техника                 | Экономия | Описание                                      |
| ----------------------- | -------- | --------------------------------------------- |
| System prompt caching   | 30-50%   | Кэширование системных промптов на стороне API |
| Context window trimming | 20-40%   | Удаление старых сообщений из контекста        |
| Summary-based history   | 50-70%   | Замена полной истории на саммари              |
| Prompt templates        | 10-20%   | Оптимизированные шаблоны промптов             |

#### Tiered Model Selection

Выбор модели на основе сложности задачи:

```typescript
function selectModel(task: Task): string {
  const complexity = estimateComplexity(task);

  if (complexity < 0.3) {
    // Простые задачи: быстрая и дешевая модель
    return "gigachat-lite";
  } else if (complexity < 0.7) {
    // Средние задачи: сбалансированная модель
    return "gigachat-pro";
  } else {
    // Сложные задачи: наиболее мощная модель
    return "deepseek-coder-v2"; // или gigachat-max
  }
}
```

#### Batch Processing

Группировка запросов для снижения overhead:

```typescript
class BatchProcessor {
  private queue: BatchItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly maxBatchSize = 10;
  private readonly maxWaitMs = 100;

  async add(request: LLMRequest): Promise<LLMResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });

      if (this.queue.length >= this.maxBatchSize) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const batch = this.queue.splice(0, this.maxBatchSize);
    // Отправляем batch-запрос к Cloud.ru API
    // ...
  }
}
```

---

## 10. Дорожная карта реализации

### 10.1 Обзор фаз

```
Неделя:  1    2    3    4    5    6    7    8    9   10   11   12   13   14   15

Phase 1: Foundation
         [====|====|====]

Phase 2: Core Integration
                   [====|====|====|====]

Phase 3: Advanced Features
                                  [====|====|====|====|====|====]

Phase 4: Production
                                                           [====|====|====]

Milestones:
         ^                   ^                        ^              ^
         |                   |                        |              |
     MVP Demo          Alpha Release           Beta Release     Production
```

### 10.2 Phase 1: Foundation (Недели 1-3)

**Цель:** Базовая инфраструктура и proof-of-concept.

| Задача                                | Длительность | Зависимости      | Результат                  |
| ------------------------------------- | ------------ | ---------------- | -------------------------- |
| Настройка Cloud.ru аккаунта и проекта | 1 день       | --               | Рабочий аккаунт с IAM      |
| Регистрация MAX бота через @MasterBot | 1 день       | --               | Bot token                  |
| Настройка CI/CD pipeline              | 2 дня        | --               | GitHub Actions / GitLab CI |
| Инициализация проекта OpenClaw        | 2 дня        | --               | Monorepo structure         |
| Реализация Cloud.ru Auth Provider     | 2 дня        | Cloud.ru аккаунт | Auth module                |
| Реализация Foundation Models Client   | 3 дня        | Auth Provider    | LLM client                 |
| Базовый MAX Bot Handler (echo)        | 2 дня        | Bot token        | Working bot                |
| Message Router (basic)                | 2 дня        | Bot Handler      | Command routing            |
| Gateway с REST API                    | 3 дня        | --               | REST endpoints             |
| Unit tests                            | Параллельно  | --               | > 80% coverage             |

**Deliverables Phase 1:**

- Работающий MAX-бот, отвечающий на команды `/start`, `/help`.
- Прямой вызов Cloud.ru Foundation Models API из OpenClaw.
- Базовый REST API Gateway.
- CI/CD pipeline.

### 10.3 Phase 2: Core Integration (Недели 3-7)

**Цель:** Полная интеграция MAX Bot API и Cloud.ru AI Agents.

| Задача                               | Длительность | Зависимости    | Результат          |
| ------------------------------------ | ------------ | -------------- | ------------------ |
| Полная интеграция MAX Bot events     | 3 дня        | Phase 1        | All event handlers |
| Inline keyboards и callback handling | 2 дня        | MAX Bot events | Interactive UI     |
| Session Manager (Redis)              | 3 дня        | --             | User sessions      |
| Conversation history (PostgreSQL)    | 2 дня        | --             | Persistent history |
| Cloud.ru AI Agents CRUD              | 3 дня        | Auth Provider  | Agent lifecycle    |
| Agent Manager (registry + pool)      | 3 дня        | AI Agents CRUD | Agent management   |
| Task Orchestrator (basic DAG)        | 4 дня        | Agent Manager  | Task execution     |
| MCP Client integration               | 3 дня        | AI Agents      | Tool calling       |
| WebSocket Server                     | 2 дня        | --             | Real-time channel  |
| Error handling и retry logic         | 2 дня        | All components | Resilience         |
| Integration tests                    | Параллельно  | --             | E2E test suite     |

**Deliverables Phase 2:**

- Полноценный чат-бот MAX с поддержкой AI-ответов.
- Создание и управление агентами через Cloud.ru API.
- Выполнение задач с использованием AI-агентов.
- MCP-интеграция для внешних инструментов.
- Real-time обновления через WebSocket.

### 10.4 Phase 3: Advanced Features (Недели 6-12)

**Цель:** Продвинутые возможности и оптимизация.

| Задача                         | Длительность | Зависимости       | Результат                 |
| ------------------------------ | ------------ | ----------------- | ------------------------- |
| MAX Mini App (React SPA)       | 5 дней       | Phase 2           | Web interface in MAX      |
| MAX Bridge integration         | 2 дня        | Mini App          | Platform APIs access      |
| Agent Systems (A2A)            | 4 дня        | Agent Manager     | Multi-agent coordination  |
| Managed RAG integration        | 3 дня        | Cloud.ru API      | Knowledge base            |
| LLM response caching           | 2 дня        | Redis             | Cost optimization         |
| Prompt compression             | 2 дня        | LLM Client        | Token optimization        |
| Tiered model selection         | 2 дня        | Task Orchestrator | Smart routing             |
| Webhook pipeline (queue-based) | 3 дня        | Gateway           | Production-ready webhooks |
| File upload/download via MAX   | 2 дня        | MAX Bot           | File handling             |
| Admin dashboard (Mini App)     | 4 дня        | Mini App          | Admin interface           |
| Load testing                   | 3 дня        | All components    | Performance baseline      |

**Deliverables Phase 3:**

- MAX Mini App для расширенного UI.
- Мультиагентные системы (Agent Systems).
- RAG-обогащенные ответы из базы знаний.
- Оптимизированное потребление токенов.
- Административный интерфейс.

### 10.5 Phase 4: Production (Недели 12-15)

**Цель:** Подготовка к продакшн-развертыванию.

| Задача                                  | Длительность | Зависимости    | Результат           |
| --------------------------------------- | ------------ | -------------- | ------------------- |
| Security audit                          | 3 дня        | All components | Security report     |
| Penetration testing                     | 2 дня        | Security audit | Vuln fixes          |
| Monitoring setup (Prometheus + Grafana) | 2 дня        | --             | Dashboards          |
| Alerting rules                          | 1 день       | Monitoring     | Alert policies      |
| Structured logging (ELK/Loki)           | 2 дня        | --             | Log aggregation     |
| Distributed tracing (Jaeger)            | 2 дня        | --             | Trace visualization |
| Performance optimization                | 3 дня        | Load testing   | Optimized system    |
| K8s manifests и Helm charts             | 3 дня        | --             | Deployment configs  |
| Disaster recovery plan                  | 1 день       | --             | DR runbook          |
| API documentation (OpenAPI)             | 2 дня        | REST API       | API docs            |
| User onboarding guide                   | 1 день       | All features   | User guide          |
| Runbook для операторов                  | 1 день       | Monitoring     | Operations guide    |

**Deliverables Phase 4:**

- Защищенная, протестированная система.
- Полный мониторинг и alerting.
- Kubernetes deployment-конфигурация.
- Документация для пользователей и операторов.

---

## 11. Альтернативы и сравнение

### 11.1 Сравнение мессенджер-платформ

| Критерий                     | MAX Messenger                 | Telegram Bot API             | VK Bot API             |
| ---------------------------- | ----------------------------- | ---------------------------- | ---------------------- |
| **Целевая аудитория**        | Россия (B2B + B2C)            | Глобальная                   | Россия (B2C)           |
| **Верификация**              | Госуслуги (ЕСИА)              | Телефон                      | Телефон / VK ID        |
| **Bot API**                  | TypeScript SDK                | REST + MTProto               | REST API               |
| **Mini Apps**                | MAX Mini App                  | Telegram Web App             | VK Mini Apps           |
| **Rate Limit**               | 30 RPS / бот                  | 30 msg/sec (group)           | 20 RPS                 |
| **Inline Keyboards**         | Да                            | Да                           | Да                     |
| **File Upload**              | Да (50MB)                     | Да (50MB)                    | Да (200MB)             |
| **Payments**                 | В разработке                  | Telegram Payments            | VK Pay                 |
| **Хранение данных в РФ**     | Да                            | Нет                          | Да                     |
| **Корпоративный сегмент**    | Сильный                       | Ограниченный                 | Средний                |
| **ФЗ-152 соответствие**      | Полное                        | Нет                          | Частичное              |
| **Стоимость**                | Бесплатно                     | Бесплатно                    | Бесплатно              |
| **Суверенность**             | Полная (российская платформа) | Нет (иностранная юрисдикция) | Частичная (VK/Mail.ru) |
| **Интеграция с Госуслугами** | Нативная                      | Нет                          | Через VK ID            |

**Вывод:** MAX Messenger является оптимальным выбором для проектов, требующих соответствия российскому законодательству и верификации через Госуслуги.

### 11.2 Сравнение AI-платформ

| Критерий                   | Cloud.ru (Evolution)                                                            | Yandex Cloud AI         | SberCloud (GigaChat) |
| -------------------------- | ------------------------------------------------------------------------------- | ----------------------- | -------------------- |
| **Foundation Models**      | 20+ моделей: GigaChat, GLM-4.7, DeepSeek, Qwen3, T-pro, Mistral, LLaMA, MiniMax | YandexGPT, Llama        | GigaChat             |
| **OpenAI-совместимый API** | Да                                                                              | Частично                | Нет (свой API)       |
| **AI Agents Service**      | Да (managed)                                                                    | Нет (ручная настройка)  | Нет                  |
| **MCP Servers**            | Да (managed)                                                                    | Нет                     | Нет                  |
| **Agent Systems (A2A)**    | Да                                                                              | Нет                     | Нет                  |
| **Managed RAG**            | Да                                                                              | Да (Yandex Search API)  | Нет                  |
| **Serverless Agents**      | Да (0 -> N)                                                                     | Lambda-like (Functions) | Нет                  |
| **GPU инстансы**           | A100, H100                                                                      | A100, T4                | A100                 |
| **Сертификация ФСТЭК**     | Да                                                                              | Да                      | Да                   |
| **Хранение в РФ**          | Да                                                                              | Да                      | Да                   |
| **Мультимодальность**      | Да (Vision)                                                                     | Да (YandexGPT)          | Да (GigaChat)        |
| **Fine-tuning**            | Да                                                                              | Да                      | Ограниченный         |
| **Стоимость (LLM)**        | Конкурентная                                                                    | Средняя                 | Высокая              |
| **Ecosystem зрелость**     | Высокая (AI Factory)                                                            | Высокая (Yandex Cloud)  | Средняя              |

**Вывод:** Cloud.ru Evolution AI Factory предоставляет наиболее полную экосистему для построения AI-агентных систем:

- Единственная платформа с managed AI Agents и Agent Systems (A2A).
- OpenAI-совместимый API упрощает миграцию существующего кода.
- Встроенные MCP-серверы и Managed RAG.
- Serverless-масштабирование с нулевым минимумом инстансов.

### 11.3 Матрица принятия решений

| Фактор                    | Вес      | MAX + Cloud.ru | Telegram + Yandex | VK + SberCloud |
| ------------------------- | -------- | -------------- | ----------------- | -------------- |
| ФЗ-152 соответствие       | 0.25     | 10             | 5                 | 8              |
| AI Agent capabilities     | 0.20     | 10             | 6                 | 5              |
| API совместимость         | 0.15     | 9              | 7                 | 6              |
| Стоимость                 | 0.15     | 8              | 7                 | 6              |
| Экосистема                | 0.10     | 8              | 9                 | 7              |
| Масштабируемость          | 0.10     | 9              | 9                 | 7              |
| Верификация пользователей | 0.05     | 10             | 3                 | 6              |
| **Итого (взвешенно)**     | **1.00** | **9.25**       | **6.55**          | **6.40**       |

---

## 12. Выводы и рекомендации

### 12.1 Резюме преимуществ комбинации MAX + Cloud.ru

Комбинация MAX Messenger и Cloud.ru Evolution AI Factory предоставляет уникальный набор преимуществ для платформы OpenClaw:

1. **Полная суверенность данных.** Все пользовательские данные, модели и агенты размещаются на территории Российской Федерации с соблюдением ФЗ-152 и требований ФСТЭК.

2. **Единая экосистема AI-агентов.** Cloud.ru -- единственная российская платформа, предоставляющая managed AI Agents Service с поддержкой MCP, A2A и serverless-масштабирования.

3. **Верифицированные пользователи.** MAX Messenger обеспечивает верификацию через Госуслуги, что критически важно для B2B/B2G сценариев.

4. **OpenAI-совместимый API.** Минимальные затраты на адаптацию существующего кода и библиотек, использующих OpenAI API.

5. **Экономическая эффективность.** Serverless-модель Cloud.ru (оплата за использование) и бесплатный MAX Bot API позволяют начать с минимальными затратами.

6. **Комплексное решение.** Managed RAG, MCP-серверы и Agent Systems в одной платформе исключают необходимость интеграции множества сторонних сервисов.

### 12.2 Рекомендуемый стек технологий

| Слой              | Технология                      | Обоснование                                           |
| ----------------- | ------------------------------- | ----------------------------------------------------- |
| **Runtime**       | Node.js 20 LTS + TypeScript 5.x | Единый язык для frontend и backend, сильная типизация |
| **Bot Framework** | `@maxhub/max-bot-api`           | Официальный SDK MAX Messenger                         |
| **Web Framework** | Fastify                         | Высокая производительность, JSON Schema validation    |
| **WebSocket**     | `ws` + `@fastify/websocket`     | Нативная интеграция с Fastify                         |
| **Queue**         | BullMQ (Redis)                  | Надежные очереди задач с приоритетами                 |
| **Cache**         | Redis 7+ (Cluster)              | Сессии, кэш LLM-ответов, rate limiting                |
| **Database**      | PostgreSQL 16                   | Основное хранилище (история, конфигурации)            |
| **ORM**           | Drizzle ORM                     | Type-safe, высокая производительность                 |
| **Validation**    | Zod                             | Runtime type validation для TypeScript                |
| **LLM Client**    | OpenAI SDK (compatible)         | Совместимость с Cloud.ru Foundation Models API        |
| **Container**     | Docker + Kubernetes             | Оркестрация контейнеров                               |
| **CI/CD**         | GitHub Actions / GitLab CI      | Автоматизация развертывания                           |
| **Monitoring**    | Prometheus + Grafana            | Метрики и дашборды                                    |
| **Logging**       | Pino + Loki                     | Structured logging с агрегацией                       |
| **Tracing**       | OpenTelemetry + Jaeger          | Распределенная трассировка                            |
| **Secrets**       | HashiCorp Vault / K8s Secrets   | Безопасное хранение ключей                            |
| **Mini App**      | React 18 + Vite                 | Быстрая разработка UI в MAX                           |

### 12.3 Приоритетные сценарии использования

#### Сценарий 1: AI-ассистент в корпоративном чате (Приоритет: Высокий)

Описание: Сотрудники компании взаимодействуют с AI-ассистентом через MAX для получения ответов на вопросы, генерации документов и автоматизации рутинных задач.

```
Пользователь в MAX -> Текстовый запрос -> OpenClaw -> Cloud.ru LLM
                                                  -> RAG (корп. база знаний)
                                                  -> Ответ в MAX
```

Ценность: Повышение продуктивности сотрудников, снижение нагрузки на поддержку.

#### Сценарий 2: Мультиагентная разработка ПО (Приоритет: Высокий)

Описание: Команда разработки использует OpenClaw для автоматизации code review, генерации тестов и рефакторинга через мультиагентную систему.

```
Разработчик -> /task "Review PR #123" -> OpenClaw Orchestrator
                                          -> Planner Agent (декомпозиция)
                                          -> Coder Agent (анализ кода)
                                          -> Reviewer Agent (code review)
                                          -> Агрегация -> Результат в MAX
```

Ценность: Ускорение цикла разработки, повышение качества кода.

#### Сценарий 3: Интеллектуальная поддержка клиентов (Приоритет: Средний)

Описание: AI-бот в MAX обрабатывает запросы клиентов с использованием RAG по базе знаний продукта и эскалацией на оператора при необходимости.

```
Клиент в MAX -> Вопрос -> OpenClaw -> Cloud.ru LLM + RAG
                                   -> Ответ найден? -> Да -> Ответ клиенту
                                                    -> Нет -> Эскалация оператору
```

Ценность: Снижение нагрузки на поддержку, ускорение ответов клиентам.

#### Сценарий 4: Автоматизация документооборота (Приоритет: Средний)

Описание: Генерация и обработка документов (договоры, отчеты, ТЗ) через AI-агентов с утверждением через MAX.

```
Сотрудник -> /task "Создать ТЗ на..." -> OpenClaw -> Analyst Agent
                                                   -> Writer Agent
                                                   -> Reviewer Agent
                                                   -> Документ -> MAX (на утверждение)
```

Ценность: Ускорение создания документов, стандартизация формата.

### 12.4 Риски и митигация

| Риск                         | Вероятность | Влияние     | Митигация                                             |
| ---------------------------- | ----------- | ----------- | ----------------------------------------------------- |
| Cloud.ru API недоступен      | Низкая      | Высокое     | Circuit breaker + fallback на локальные модели        |
| MAX Platform даунтайм        | Низкая      | Среднее     | REST API / WebSocket как альтернативный канал         |
| Rate limit исчерпан (MAX)    | Средняя     | Среднее     | Queue-based message delivery, несколько ботов         |
| Превышение бюджета на токены | Средняя     | Среднее     | Alerting + hard limits + tiered model selection       |
| Утечка API ключей            | Низкая      | Критическое | Vault + ротация + мониторинг использования            |
| Cold start агентов Cloud.ru  | Высокая     | Низкое      | Предварительный прогрев, minInstances=1 для критичных |
| Деградация качества LLM      | Средняя     | Среднее     | Мониторинг качества + A/B тестирование моделей        |

### 12.5 Критерии успеха

| Метрика                               | Целевое значение | Срок            |
| ------------------------------------- | ---------------- | --------------- |
| Время ответа бота (p50)               | < 3 секунды      | Phase 2         |
| Время ответа бота (p99)               | < 10 секунд      | Phase 2         |
| Uptime системы                        | > 99.5%          | Phase 4         |
| Успешность выполнения задач           | > 90%            | Phase 3         |
| Стоимость на пользователя/мес         | < 500 руб        | Phase 4         |
| Удовлетворенность пользователей (NPS) | > 40             | Phase 4 + 1 мес |

---

## Приложение A: Глоссарий

| Термин     | Описание                                                             |
| ---------- | -------------------------------------------------------------------- |
| **A2A**    | Agent-to-Agent -- протокол межагентной коммуникации                  |
| **DAG**    | Directed Acyclic Graph -- направленный ациклический граф             |
| **ЕСИА**   | Единая система идентификации и аутентификации (Госуслуги)            |
| **LLM**    | Large Language Model -- большая языковая модель                      |
| **MCP**    | Model Context Protocol -- протокол контекста модели                  |
| **RAG**    | Retrieval-Augmented Generation -- генерация с поиском по базе знаний |
| **RPS**    | Requests Per Second -- запросов в секунду                            |
| **SSE**    | Server-Sent Events -- серверные события                              |
| **ФЗ-152** | Федеральный закон о персональных данных                              |
| **ФСТЭК**  | Федеральная служба по техническому и экспортному контролю            |

## Приложение B: Ссылки

| Ресурс                     | URL                                            |
| -------------------------- | ---------------------------------------------- |
| MAX Bot API Documentation  | https://dev.max.ru/docs/bot-api                |
| Cloud.ru AI Documentation  | https://cloud.ru/docs/ai                       |
| Cloud.ru AI Agents API     | https://cloud.ru/docs/ai/agents                |
| Cloud.ru Foundation Models | https://cloud.ru/docs/ai/foundation-models     |
| OpenAI API Reference       | https://platform.openai.com/docs/api-reference |
| MCP Specification          | https://modelcontextprotocol.io                |

## Приложение C: Architecture Decision Records

### ADR-001: Выбор MAX Messenger как основного мессенджер-канала

- **Статус:** Принято
- **Контекст:** Требуется мессенджер-платформа для пользовательского интерфейса AI-агентов с соблюдением ФЗ-152.
- **Решение:** MAX Messenger выбран как основной канал.
- **Обоснование:** Верификация через Госуслуги, хранение данных в РФ, бесплатный Bot API, поддержка Mini Apps.
- **Последствия:** Ограничение rate limit (30 RPS), необходимость изучения специфичного SDK.

### ADR-002: Выбор Cloud.ru Evolution AI Factory как AI-платформы

- **Статус:** Принято
- **Контекст:** Требуется managed AI-инфраструктура с поддержкой агентов, RAG и хранением данных в РФ.
- **Решение:** Cloud.ru Evolution AI Factory выбран как основная AI-платформа.
- **Обоснование:** Единственная платформа с managed AI Agents, MCP, A2A; OpenAI-совместимый API; сертификация ФСТЭК; serverless-масштабирование.
- **Последствия:** Зависимость от одного вендора; необходимость VPN для чувствительных данных.

### ADR-003: OpenAI-совместимый API как стандарт интеграции с LLM

- **Статус:** Принято
- **Контекст:** Необходим единый интерфейс для взаимодействия с различными LLM-моделями.
- **Решение:** Использовать OpenAI API specification как стандарт.
- **Обоснование:** Cloud.ru Foundation Models API совместим с OpenAI; возможность использовать существующие библиотеки (openai SDK); простота замены моделей.
- **Последствия:** Ограничение функциональности, специфичной для отдельных провайдеров.
