---
tags:
  - brigade
  - dmarket
  - bot
category: domain-knowledge
difficulty: intermediate
training: true
created: 2026-06-30
---

# Dmarket-Dev Brigade

Бригада разработки Dmarket-бота — отвечает за развитие торгового бота на платформе Dmarket.

## Состав цепочки

```
Planner → Coder → Auditor
```

## Правила

1. **Workspace isolation**: работает только в `D:\Dmarket_bot`, не может модифицировать код фреймворка OpenClaw
2. **Restricted namespaces**: `os.system`, `subprocess`, `openclaw_bot.core` — запрещены
3. **MCP клиент**: собственный `DmarketMCPClient` со scope только на workspace бота
4. **Security Auditor**: Checks Dmarket bot code for API key leaks and sensitive data exposure

## API и ограничения

- Dmarket API доступен через HMAC-SHA256 подпись (см. [[HMAC_SHA256_Fundamentals]])
- Rate limiting: 60 req/min для market, 10 req/min для orders (см. [[Dmarket_API_Rate_Limiting]])
- Все API ключи должны храниться в `.env` и никогда не попадать в код
- Бот использует асинхронный aiohttp клиент с exponential backoff

## Типичные задачи

- Оптимизация алгоритмов арбитража ([[Dmarket_Arbitrage_Algorithms]])
- Исправление API-интеграции ([[API_Fixes]])
- Добавление новых торговых стратегий
- Performance-оптимизация (latency-critical код)

## Модели

SmartModelRouter подбирает модели по ролям:

- **Planner**: `nvidia/nemotron-3-super-120b-a12b:free` (general)
- **Coder**: `nvidia/nemotron-3-super-120b-a12b:free` (code)
- **Auditor**: `arcee-ai/trinity-large-preview:free` (tool_execution)
