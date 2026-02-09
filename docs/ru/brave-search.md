---
summary: "Настройка API Brave Search для web_search"
read_when:
  - Вы хотите использовать Brave Search для web_search
  - Вам нужен BRAVE_API_KEY или сведения о тарифном плане
title: "Brave Search"
---

# API Brave Search

OpenClaw использует Brave Search в качестве провайдера по умолчанию для `web_search`.

## Получение ключа API

1. Создайте учётную запись Brave Search API на [https://brave.com/search/api/](https://brave.com/search/api/)
2. В панели управления выберите тариф **Data for Search** и сгенерируйте ключ API.
3. Сохраните ключ в конфиге (рекомендуется) или задайте `BRAVE_API_KEY` в переменных окружения Gateway (шлюз).

## Пример конфига

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Примечания

- Тариф Data for AI **не** совместим с `web_search`.
- Brave предлагает бесплатный уровень и платные тарифы; актуальные ограничения см. на портале Brave API.

[Web tools](/tools/web) для полной конфигурации web_search.
