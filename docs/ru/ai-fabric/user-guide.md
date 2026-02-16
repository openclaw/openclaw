# Cloud.ru AI Fabric — Руководство пользователя

> **Платформа:** Cloud.ru Evolution AI Factory
> **Версия документа:** 1.0
> **Дата:** Февраль 2026

---

## Быстрый старт

### 1. Получите API-ключ

1. Зарегистрируйтесь на [cloud.ru](https://cloud.ru) (без VPN, российская карта или Госуслуги)
2. Перейдите в **Evolution → Foundation Models → Учётные данные доступа**
3. Создайте API-ключ и сохраните Key Secret

### 2. Настройте окружение

```bash
export OPENAI_API_KEY="ваш-cloud-ru-api-key"
export OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1/"
```

### 3. Сделайте первый запрос

```bash
curl $OPENAI_BASE_URL/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "zai-org/GLM-4.7-Flash",
    "messages": [{"role": "user", "content": "Привет!"}],
    "max_tokens": 100
  }'
```

---

## Работа с Foundation Models

### Использование через Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://foundation-models.api.cloud.ru/v1/",
    api_key="ваш-api-key"
)

# Простой запрос
response = client.chat.completions.create(
    model="zai-org/GLM-4.7-Flash",
    messages=[
        {"role": "system", "content": "Ты полезный ассистент."},
        {"role": "user", "content": "Расскажи о Cloud.ru"}
    ],
    temperature=0.7,
    max_tokens=2048
)

print(response.choices[0].message.content)
```

### Использование через TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://foundation-models.api.cloud.ru/v1/",
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
  model: "zai-org/GLM-4.7-Flash",
  messages: [
    { role: "system", content: "Ты полезный ассистент." },
    { role: "user", content: "Напиши функцию сортировки на Python" },
  ],
  temperature: 0.7,
  max_tokens: 2048,
});

console.log(response.choices[0].message.content);
```

### Потоковая генерация (Streaming)

```python
stream = client.chat.completions.create(
    model="zai-org/GLM-4.7-Flash",
    messages=[{"role": "user", "content": "Напиши эссе о AI"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Function Calling (Вызов инструментов)

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Получить текущую погоду в городе",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "Название города"
                    }
                },
                "required": ["city"]
            }
        }
    }
]

response = client.chat.completions.create(
    model="Qwen/Qwen3-235B-Instruct",
    messages=[{"role": "user", "content": "Какая погода в Москве?"}],
    tools=tools,
    tool_choice="auto"
)

# Обработать tool_calls из response
```

---

## Какую модель выбрать?

### Для повседневных задач

| Что нужно                 | Модель             | Почему                           |
| ------------------------- | ------------------ | -------------------------------- |
| Вопрос-ответ на русском   | **GigaChat-2-Max** | Лучшее понимание русского языка  |
| Быстрый ответ бесплатно   | **GLM-4.7-Flash**  | Бесплатный тир, хорошее качество |
| Анализ длинного документа | **GLM-4.7**        | Контекст 200K токенов            |

### Для разработчиков

| Что нужно              | Модель               | Почему                                 |
| ---------------------- | -------------------- | -------------------------------------- |
| Генерация кода         | **Qwen3-Coder-480B** | Специализация на коде, 480B параметров |
| Новейший код-ассистент | **Qwen3-Coder-Next** | Самая новая модель для кода            |
| Код + рассуждение      | **DeepSeek-R1**      | Reasoning-first архитектура            |

### Для аналитиков

| Что нужно            | Модель           | Почему                      |
| -------------------- | ---------------- | --------------------------- |
| Логический анализ    | **DeepSeek-R1**  | Пошаговое рассуждение       |
| Финансовая аналитика | **T-pro-it-2.1** | Специализация на финансах   |
| Универсальный анализ | **Qwen3-235B**   | Мощная универсальная модель |

---

## Работа с AI-агентами

### Взаимодействие через API

```python
import requests

# Отправка запроса агенту
response = requests.post(
    f"https://ai-agents.api.cloud.ru/api/v1/{project_id}/agents/{agent_id}/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    },
    json={
        "messages": [
            {"role": "user", "content": "Проанализируй продажи за Q4"}
        ]
    }
)

result = response.json()
print(result["choices"][0]["message"]["content"])
```

### Типовые сценарии использования

**FAQ-бот (Simple Reactive Agent):**

- Системный промпт с правилами ответов
- Подключение базы знаний через Managed RAG
- Serverless-режим (Min Instances = 0) для экономии

**Код-ассистент (Goal-Directed Agent):**

- Модель: Qwen3-Coder-480B
- Инструменты: Git MCP Server, Code Execution
- Постоянный режим (Min Instances = 1) для быстрого отклика

**Аналитик данных (Utility-Maximizing Agent):**

- Модель: DeepSeek-R1
- Инструменты: PostgreSQL MCP Server, S3 MCP Server
- Подключение к Managed RAG с аналитическими отчётами

---

## Работа с Managed RAG

### Создание базы знаний

1. Перейти в **Evolution → Managed RAG**
2. Создать коллекцию
3. Загрузить документы (PDF, DOCX, TXT, Markdown, HTML)
4. Дождаться автоматической индексации
5. Подключить к агенту через MCP-сервер

### Поиск по базе знаний

Managed RAG поддерживает два типа поиска:

- **Векторный поиск** — семантический поиск по смыслу запроса
- **Полнотекстовый поиск** — точное совпадение ключевых слов

Агент автоматически использует поиск через MCP-сервер Managed RAG.

---

## Обработка ошибок

### Rate Limit (429)

Foundation Models ограничены 15 запросами/секунду на ключ. Реализуйте exponential backoff:

```python
import time
from openai import RateLimitError

def safe_request(client, messages, retries=3):
    for i in range(retries):
        try:
            return client.chat.completions.create(
                model="zai-org/GLM-4.7-Flash",
                messages=messages,
                max_tokens=500
            )
        except RateLimitError:
            if i < retries - 1:
                time.sleep(2 ** i)
            else:
                raise
```

### Таймаут

```python
response = client.chat.completions.create(
    model="zai-org/GLM-4.7-Flash",
    messages=messages,
    max_tokens=500,
    timeout=30.0  # 30 секунд
)
```

### Обработка streaming-ошибок

```python
try:
    stream = client.chat.completions.create(
        model="zai-org/GLM-4.7-Flash",
        messages=messages,
        stream=True
    )
    for chunk in stream:
        if chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="")
except Exception as e:
    print(f"Ошибка стриминга: {e}")
```

---

## AI Playground

AI Playground — интерактивная среда в браузере для тестирования моделей без кода:

1. Перейти в **Evolution → Foundation Models → AI Playground**
2. Выбрать модель (или несколько для сравнения)
3. Задать промпт и параметры (temperature, max_tokens и т.д.)
4. Получить ответ и при необходимости скопировать cURL/SDK-код

---

## Интеграция с VS Code

Cloud.ru предоставляет интеграцию Foundation Models с VS Code:

1. Следовать [инструкции на cloud.ru](https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode)
2. Указать API-ключ и базовый URL
3. Использовать модели Cloud.ru как AI-ассистента в IDE

---

## Советы

- Начните с бесплатной модели **GLM-4.7-Flash** для экспериментов
- Используйте **AI Playground** для подбора промптов перед интеграцией
- Для русскоязычных задач в продакшене — **GigaChat-2-Max**
- Для кода — **Qwen3-Coder-480B** или **Qwen3-Coder-Next**
- Всегда реализуйте retry-логику с exponential backoff
- Хранилище S3 (15 ГБ бесплатно) — для баз знаний Managed RAG

---

## Ссылки

- [Foundation Models Quick Start](https://cloud.ru/docs/foundation-models/ug/topics/quickstart)
- [Foundation Models API Reference](https://cloud.ru/docs/foundation-models/ug/topics/api-ref)
- [AI Agents — Создание агента](https://cloud.ru/docs/ai-agents/ug/topics/guides__create-agent)
- [Managed RAG](https://cloud.ru/docs/rag/ug/index)
- [AI Playground](https://cloud.ru/products/evolution-foundation-models)
- [VS Code Integration](https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode)
