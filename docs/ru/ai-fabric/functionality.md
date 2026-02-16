# Cloud.ru AI Fabric — Функциональность

> **Платформа:** Cloud.ru Evolution AI Factory
> **Версия документа:** 1.0
> **Дата:** Февраль 2026

---

## Foundation Models

### Каталог моделей

Cloud.ru предоставляет доступ к 20+ генеративным моделям через единый OpenAI-совместимый API.

#### Российские модели

| Модель             | Разработчик | Контекст | Tool Calling | Особенности                           |
| ------------------ | ----------- | -------- | ------------ | ------------------------------------- |
| **GigaChat-2-Max** | Сбер        | 32K      | Ограниченно  | Лучшая русскоязычная модель           |
| **GigaChat-2-Pro** | Сбер        | 32K      | Ограниченно  | Оптимальное соотношение качество/цена |
| **T-pro-it-2.0**   | T-Bank      | 32K      | Ограниченно  | Специализация на финансах             |
| **T-pro-it-2.1**   | T-Bank      | 32K      | Ограниченно  | Улучшенное следование инструкциям     |
| **T-lite-it-2.1**  | T-Bank      | 32K      | Ограниченно  | Лёгкая модель, быстрый инференс       |

#### Международные модели (доступные на территории РФ)

| Модель               | Разработчик | Параметры | Контекст | Tool Calling | Reasoning                |
| -------------------- | ----------- | --------- | -------- | ------------ | ------------------------ |
| **GLM-4.7**          | Zhipu AI    | 358B MoE  | 200K     | Да           | Thinking mode            |
| **GLM-4.7-Flash**    | Zhipu AI    | MoE       | 200K     | Да           | Бесплатный тир           |
| **Qwen3-235B**       | Alibaba     | 235B MoE  | 128K     | Да           | Да                       |
| **Qwen3-Coder-480B** | Alibaba     | 480B MoE  | 128K     | Да           | Специализация на коде    |
| **Qwen3-Coder-Next** | Alibaba     | MoE       | 128K     | Да           | Новейшая модель для кода |
| **DeepSeek-V3**      | DeepSeek    | 671B MoE  | 128K     | Да           | Да                       |
| **DeepSeek-R1**      | DeepSeek    | 671B MoE  | 128K     | Да           | Reasoning-first          |
| **Mistral Large**    | Mistral AI  | —         | 128K     | Да           | Нет                      |
| **LLaMA 3.3 70B**    | Meta        | 70B       | 128K     | Да           | Нет                      |
| **MiniMax-M2**       | MiniMax     | —         | —        | Да           | —                        |

> **GLM-4.7-Flash** доступна на бесплатном тарифе для экспериментов.

### OpenAI-совместимый API

```
Base URL:       https://foundation-models.api.cloud.ru/v1/
Формат:         OpenAI-совместимый (/v1/chat/completions)
Аутентификация: API Key через сервисный аккаунт
Rate Limit:     15 запросов/секунду на ключ
```

**Поддерживаемые эндпоинты:**

| Эндпоинт                    | Описание                 |
| --------------------------- | ------------------------ |
| `POST /v1/chat/completions` | Генерация ответов (чат)  |
| `POST /v1/completions`      | Генерация текста         |
| `POST /v1/embeddings`       | Векторные представления  |
| `GET /v1/models`            | Список доступных моделей |

### Параметры генерации

| Параметр            | Диапазон      | Описание                                    |
| ------------------- | ------------- | ------------------------------------------- |
| `temperature`       | 0.0–2.0       | Случайность генерации                       |
| `top_p`             | 0.0–1.0       | Nucleus sampling                            |
| `max_tokens`        | 1–model max   | Максимальная длина ответа                   |
| `stop`              | string[]      | Стоп-последовательности                     |
| `frequency_penalty` | -2.0–2.0      | Штраф за повторения                         |
| `presence_penalty`  | -2.0–2.0      | Штраф за присутствие токенов                |
| `stream`            | boolean       | Потоковая генерация                         |
| `tools`             | object[]      | Определения инструментов (function calling) |
| `tool_choice`       | string/object | Стратегия вызова инструментов               |

### AI Playground

Интерактивная среда для тестирования моделей в браузере:

- Сравнение нескольких моделей одновременно
- Настройка temperature, top_p, max_tokens, stop sequences
- Генерация cURL-команд и SDK-кода
- Шаблоны промптов и история запросов

---

## AI Agents

### Три метода создания агентов

#### 1. Simple Agent (Минимальная настройка)

Используется Docker-образ по умолчанию. Создание за 2–3 минуты без знания Docker.

**Шаги:** Имя → Модель → Системный промпт → (MCP-серверы) → Масштабирование → Запуск

#### 2. Catalog Agent (Из каталога Marketplace)

На основе готовых шаблонов: RAG-ассистент, кодер-ревьюер, аналитик данных, клиентский саппорт.

**Шаги:** Шаблон из каталога → Настройка параметров → MCP-серверы → Масштабирование → Запуск

#### 3. Docker Image Agent (Полная кастомизация)

Собственный Docker-образ с полностью кастомной логикой. Поддержка LangChain, LlamaIndex, AutoGen и других фреймворков.

**Шаги:** Docker-образ → Container Registry → Создание агента → Переменные окружения → Ресурсы → Запуск

### Конфигурация агента

| Параметр               | Описание                                  | Обязательный  |
| ---------------------- | ----------------------------------------- | ------------- |
| Имя                    | Уникальное имя в рамках проекта           | Да            |
| Описание               | Назначение и поведение агента             | Нет           |
| Модель                 | LLM из Foundation Models или ML Inference | Да            |
| Ресурсная конфигурация | Instance type (CPU/GPU/RAM)               | Да            |
| Системный промпт       | Инструкции для поведения агента           | Рекомендуется |
| MCP-серверы            | Внешние источники данных                  | Нет           |
| Переменные окружения   | Секреты и конфигурация                    | Нет           |

### Масштабирование

| Параметр                | Описание                              |
| ----------------------- | ------------------------------------- |
| **Min Instances**       | 0 = serverless (cold start 10–30 сек) |
| **Max Instances**       | Ограничено квотой                     |
| **Keep-alive**          | Время жизни idle-инстанса             |
| **Тип масштабирования** | По RPS или Concurrency                |

---

## MCP-серверы

### MCP Registry — каталог готовых серверов

| Категория              | Примеры серверов      | Назначение                    |
| ---------------------- | --------------------- | ----------------------------- |
| Данные                 | Managed RAG Server    | Поиск по базе знаний          |
| Коммуникации           | Email MCP Server      | Отправка/получение email      |
| Хранилища              | S3 MCP Server         | Работа с объектным хранилищем |
| Базы данных            | PostgreSQL MCP Server | Запросы к БД                  |
| Поиск                  | Web Search MCP Server | Поиск в интернете             |
| Инструменты разработки | Git MCP Server        | Работа с Git-репозиториями    |

### Кастомные MCP-серверы

Для специфических задач можно создать собственный MCP-сервер:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "my-custom-server",
  version: "1.0.0",
});

server.tool(
  "search_knowledge_base",
  "Поиск по корпоративной базе знаний",
  {
    query: { type: "string", description: "Поисковый запрос" },
    limit: { type: "number", description: "Максимум результатов", default: 10 },
  },
  async ({ query, limit }) => {
    const results = await searchKB(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Деплой:** Docker-образ → Container Registry → Регистрация в AI Agents → Подключение к агентам

---

## Managed RAG

Управляемый сервис для построения баз знаний без развёртывания инфраструктуры.

```
AI Agent ──▶ MCP Server (RAG) ──▶ Managed RAG
                                    ├─ Vector DB
                                    ├─ Документы
                                    └─ Индексы
```

**Возможности:**

- Векторный + полнотекстовый поиск
- Автоматическая векторизация документов (PDF, DOCX, TXT, Markdown, HTML)
- Интеграция с Foundation Models и ML Inference
- S3-совместимое объектное хранилище (15 ГБ бесплатно)

---

## ML Inference

Деплой и запуск ML-моделей на облачных GPU-ресурсах.

**Ключевые возможности:**

- GPU: Nvidia V100, A100, H100 (shared)
- Фреймворки: vLLM, TGI, Ollama, Diffusers, Transformers
- Docker-образы с автодеплоем
- Динамическое автомасштабирование
- Интеграция с HuggingFace

---

## ML Finetuning

Дообучение LLM на собственных данных:

- LoRA / QLoRA
- Управление экспериментами
- Интеграция с Foundation Models и ML Inference

---

## Notebooks

Интерактивная Jupyter-подобная среда разработки:

- GPU-ноутбуки
- Предустановленные ML-библиотеки
- Прототипирование и эксперименты

---

## Рекомендации по выбору моделей

| Задача                  | Рекомендуемые модели                         |
| ----------------------- | -------------------------------------------- |
| Генерация кода          | Qwen3-Coder-480B, Qwen3-Coder-Next, Devstral |
| Русскоязычные задачи    | GigaChat-2-Max, GigaChat-2-Pro               |
| Длинный контекст        | GLM-4.7 (200K), GLM-4.7-Flash (200K)         |
| Reasoning               | DeepSeek-R1, T-pro-it-2.1                    |
| Бесплатные эксперименты | GLM-4.7-Flash                                |

---

## Ссылки

- [Evolution AI Factory](https://cloud.ru/products/evolution-ai-factory)
- [Foundation Models](https://cloud.ru/products/evolution-foundation-models)
- [AI Agents](https://cloud.ru/products/evolution-ai-agents)
- [Managed RAG](https://cloud.ru/docs/rag/ug/index)
- [ML Inference](https://cloud.ru/products/evolution-ml-inference)
- [Foundation Models API](https://cloud.ru/docs/foundation-models/ug/topics/api-ref)
