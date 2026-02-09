---
summary: "Используйте единый API Qianfan для доступа ко многим моделям в OpenClaw"
read_when:
  - Вам нужен один ключ API для многих LLM
  - Вам требуется руководство по настройке Baidu Qianfan
title: "Qianfan"
---

# Руководство по провайдеру Qianfan

Qianfan — это MaaS‑платформа Baidu, которая предоставляет **единый API**, направляющий запросы к множеству моделей через один
endpoint и один ключ API. Она совместима с OpenAI, поэтому большинство SDK OpenAI работают при смене базового URL.

## Предварительные требования

1. Учётная запись Baidu Cloud с доступом к API Qianfan
2. Ключ API из консоли Qianfan
3. Установленный на вашей системе OpenClaw

## Получение ключа API

1. Перейдите в [консоль Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Создайте новое приложение или выберите существующее
3. Сгенерируйте ключ API (формат: `bce-v3/ALTAK-...`)
4. Скопируйте ключ API для использования с OpenClaw

## настройка CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Связанная документация

- [Конфигурация OpenClaw](/gateway/configuration)
- [Провайдеры моделей](/concepts/model-providers)
- [Настройка агента](/concepts/agent)
- [Документация по API Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
