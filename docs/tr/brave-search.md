---
summary: "web_search için Brave Search API kurulumu"
read_when:
  - web_search için Brave Search kullanmak istiyorsunuz
  - Bir BRAVE_API_KEY veya plan ayrıntılarına ihtiyacınız var
title: "Brave Search"
x-i18n:
  source_path: brave-search.md
  source_hash: 81cd0a13239c13f4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:44Z
---

# Brave Search API

OpenClaw, `web_search` için varsayılan sağlayıcı olarak Brave Search kullanır.

## API anahtarı alma

1. [https://brave.com/search/api/](https://brave.com/search/api/) adresinde bir Brave Search API hesabı oluşturun.
2. Gösterge panelinde **Data for Search** planını seçin ve bir API anahtarı oluşturun.
3. Anahtarı yapılandırmada saklayın (önerilir) veya Gateway ortamında `BRAVE_API_KEY` ayarlayın.

## Yapılandırma örneği

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

## Notlar

- **Data for AI** planı, `web_search` ile **uyumlu değildir**.
- Brave, ücretsiz bir katman ve ücretli planlar sunar; güncel limitler için Brave API portalını kontrol edin.

web_search yapılandırmasının tamamı için [Web tools](/tools/web) sayfasına bakın.
