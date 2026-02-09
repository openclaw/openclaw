---
summary: "Użyj ujednoliconego API Qianfan, aby uzyskać dostęp do wielu modeli w OpenClaw"
read_when:
  - Chcesz jednego klucza API dla wielu LLM-ów
  - Potrzebujesz wskazówek dotyczących konfiguracji Baidu Qianfan
title: "Qianfan"
---

# Przewodnik dostawcy Qianfan

Qianfan to platforma MaaS firmy Baidu, która udostępnia **ujednolicone API** kierujące żądania do wielu modeli za jednym
punktem końcowym i kluczem API. Jest zgodna z OpenAI, więc większość SDK OpenAI działa po przełączeniu bazowego adresu URL.

## Wymagania wstępne

1. Konto Baidu Cloud z dostępem do API Qianfan
2. Klucz API z konsoli Qianfan
3. Zainstalowany OpenClaw w systemie

## Uzyskiwanie klucza API

1. Odwiedź [Konsolę Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Utwórz nową aplikację lub wybierz istniejącą
3. Wygeneruj klucz API (format: `bce-v3/ALTAK-...`)
4. Skopiuj klucz API do użycia z OpenClaw

## konfiguracja CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Powiązana dokumentacja

- [Konfiguracja OpenClaw](/gateway/configuration)
- [Dostawcy modeli](/concepts/model-providers)
- [Konfiguracja agenta](/concepts/agent)
- [Dokumentacja API Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
