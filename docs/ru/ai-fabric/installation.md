# Cloud.ru AI Fabric — Установка и настройка

> **Платформа:** Cloud.ru Evolution AI Factory
> **Версия документа:** 1.0
> **Дата:** Февраль 2026

---

## Предварительные требования

- Аккаунт Cloud.ru Evolution (регистрация через email или Госуслуги)
- Доступ из РФ без VPN
- Для оплаты — российская банковская карта (бесплатный тир доступен без карты)

---

## Шаг 1. Регистрация в Cloud.ru

1. Перейти на [cloud.ru](https://cloud.ru)
2. Нажать «Регистрация»
3. Пройти верификацию (email или Госуслуги)
4. Активировать Evolution AI Factory в консоли

---

## Шаг 2. Создание API-ключа для Foundation Models

1. Войти в консоль Cloud.ru Evolution
2. Перейти в **Evolution → Foundation Models**
3. Открыть раздел **Учётные данные доступа**
4. Нажать **Создать API-ключ**
5. Заполнить параметры:
   - **Имя:** например, `openclaw-integration`
   - **Описание:** например, `API key for OpenClaw bot`
   - **Сервис:** Foundation Models
6. **Сохранить Key Secret** — после закрытия окна его нельзя будет получить повторно

---

## Шаг 3. Настройка переменных окружения

### Linux / macOS

Добавить в `~/.bashrc` или `~/.zshrc`:

```bash
export OPENAI_API_KEY="ваш-cloud-ru-api-key"
export OPENAI_BASE_URL="https://foundation-models.api.cloud.ru/v1/"
```

Применить:

```bash
source ~/.bashrc
```

### Файл .env

```bash
OPENAI_API_KEY=ваш-cloud-ru-api-key
OPENAI_BASE_URL=https://foundation-models.api.cloud.ru/v1/
```

### Для нескольких сервисов

```bash
# Foundation Models
export CLOUD_RU_FM_API_KEY="ключ-для-foundation-models"

# AI Agents
export CLOUD_RU_AGENTS_API_KEY="ключ-для-ai-agents"

# Managed RAG
export CLOUD_RU_RAG_API_KEY="ключ-для-managed-rag"
```

---

## Шаг 4. Проверка подключения

### cURL

```bash
curl https://foundation-models.api.cloud.ru/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "zai-org/GLM-4.7-Flash",
    "messages": [
      {"role": "user", "content": "Привет, Cloud.ru!"}
    ],
    "max_tokens": 100
  }'
```

### Python (OpenAI SDK)

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://foundation-models.api.cloud.ru/v1/",
    api_key="ваш-api-key"
)

response = client.chat.completions.create(
    model="zai-org/GLM-4.7-Flash",
    messages=[{"role": "user", "content": "Привет!"}],
    max_tokens=100
)

print(response.choices[0].message.content)
```

### TypeScript (OpenAI SDK)

```bash
npm install openai
```

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://foundation-models.api.cloud.ru/v1/",
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
  model: "zai-org/GLM-4.7-Flash",
  messages: [{ role: "user", content: "Привет!" }],
  max_tokens: 100,
});

console.log(response.choices[0].message.content);
```

---

## Шаг 5. Создание AI-агента

### Через консоль Cloud.ru

1. Перейти в **Evolution → AI Agents**
2. Нажать **Создать агента**
3. Выбрать метод:
   - **Simple Agent** — быстрый старт (2–3 минуты)
   - **Catalog Agent** — из готового шаблона
   - **Docker Image Agent** — полная кастомизация
4. Указать имя, модель и системный промпт
5. (Опционально) Подключить MCP-серверы
6. Настроить масштабирование
7. Запустить

### Вызов агента через API

```bash
curl -X POST https://ai-agents.api.cloud.ru/api/v1/{project_id}/agents/{agent_id}/completions \
  -H "Authorization: Bearer $CLOUD_RU_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Проанализируй этот код..."}
    ]
  }'
```

---

## Шаг 6. Настройка Managed RAG

1. Перейти в **Evolution → Managed RAG**
2. Создать коллекцию (базу знаний)
3. Загрузить документы (PDF, DOCX, TXT, Markdown, HTML)
4. Дождаться индексации (автоматическая векторизация)
5. Подключить MCP-сервер Managed RAG к агенту

---

## Шаг 7. Настройка VM для OpenClaw

### Создание виртуальной машины

1. Перейти в **Evolution → Cloud Servers**
2. Создать VM с требуемой конфигурацией
3. Настроить частную сеть через Magic Router
4. Настроить firewall-правила

### Установка зависимостей на VM

```bash
# Node.js / TypeScript стек
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Python стек
sudo apt-get install -y python3 python3-pip
pip3 install openai

# Docker (для кастомных агентов)
curl -fsSL https://get.docker.com | sh
```

### Конфигурация OpenClaw

```bash
# Клонировать репозиторий
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Установить зависимости
npm install

# Настроить переменные окружения
cp .env.example .env
# Отредактировать .env — указать API-ключи Cloud.ru
```

---

## Безопасность API-ключей

- Хранить ключи в переменных окружения или secrets manager
- Никогда не коммитить ключи в систему контроля версий
- Ротировать ключи периодически
- Ограничивать scope ключа до необходимых сервисов
- Использовать частную сеть для вызовов AI-сервисов

---

## Решение проблем

| Проблема                | Решение                                                   |
| ----------------------- | --------------------------------------------------------- |
| `401 Unauthorized`      | Проверить API-ключ и формат `Authorization: Bearer <key>` |
| `429 Too Many Requests` | Rate limit 15 RPS — добавить exponential backoff          |
| `Connection timeout`    | Проверить сетевую связность, использовать частную сеть    |
| Cold start (10–30 сек)  | Установить Min Instances >= 1 для постоянного режима      |

---

## Ссылки

- [Foundation Models Quick Start](https://cloud.ru/docs/foundation-models/ug/topics/quickstart)
- [AI Agents — Создание агента](https://cloud.ru/docs/ai-agents/ug/topics/guides__create-agent)
- [Managed RAG — Начало работы](https://cloud.ru/docs/rag/ug/index)
- [VS Code Integration](https://cloud.ru/docs/foundation-models/ug/topics/tutorials__connect-vscode)
