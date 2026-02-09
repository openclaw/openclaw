---
summary: "web_search için Brave Search API kurulumu"
read_when:
  - web_search için Brave Search kullanmak istiyorsunuz
  - Bir BRAVE_API_KEY veya plan ayrıntılarına ihtiyacınız var
title: "Brave Search"
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
