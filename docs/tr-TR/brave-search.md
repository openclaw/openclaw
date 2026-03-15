---
summary: "web_search için Brave Search API kurulumu"
read_when:
  - web_search için Brave Search kullanmak istiyorsanız
  - BRAVE_API_KEY veya plan detaylarına ihtiyacınız varsa
title: "Brave Search"
---

# Brave Search API

OpenClaw, `web_search` sağlayıcısı olarak Brave Search API'yi destekler.

## API Anahtarı Al

1. [https://brave.com/search/api/](https://brave.com/search/api/) adresinden Brave Search API hesabı oluşturun
2. Dashboard'da **Search** planını seçin ve bir API anahtarı oluşturun.
3. Anahtarı config'te saklayın veya Gateway ortamında `BRAVE_API_KEY` ayarlayın.

## Yapılandırma Örneği

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

## Araç Parametreleri

| Parametre     | Açıklama                                                         |
| ------------- | ------------------------------------------------------------------- |
| `query`       | Arama sorgusu (gerekli)                                             |
| `count`       | Döndürülecek sonuç sayısı (1-10, varsayılan: 5)                      |
| `country`     | 2 harfli ISO ülke kodu (örn. "US", "DE")                        |
| `language`    | Arama sonuçları için ISO 639-1 dil kodu (örn. "en", "de", "fr") |
| `ui_lang`     | UI öğeleri için ISO dil kodu                                   |
| `freshness`   | Zaman filtresi: `day` (24s), `week`, `month`, veya `year`                |
| `date_after`  | Yalnızca bu tarihten sonra yayınlanan sonuçlar (YYYY-AA-GG)                 |
| `date_before` | Yalnızca bu tarihten önce yayınlanan sonuçlar (YYYY-AA-GG)                |

**Örnekler:**

```javascript
// Ülke ve dile özel arama
await web_search({
  query: "yenilenebilir enerji",
  country: "DE",
  language: "de",
});

// Son sonuçlar (son hafta)
await web_search({
  query: "AI haberleri",
  freshness: "week",
});

// Tarih aralığı araması
await web_search({
  query: "AI gelişmeleri",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## Notlar

- OpenClaw Brave **Search** planını kullanıyor. Eski bir aboneliğiniz varsa (örn. aylık 2.000 sorguluk orijinal Ücretsiz plan), geçerli kalır ancak LLM Context veya daha yüksek oran sınırları gibi yeni özellikleri içermez.
- Her Brave planı **aylık 5$ ücretsiz kredi** (yenileniyor) içerir. Search planı 1.000 istek başına 5$ maliyetlidir, yani kredi aylık 1.000 sorguyu karşılar. Beklenmedik ücretlerden kaçınmak için Brave dashboard'da kullanım limitinizi ayarlayın. Mevcut planlar için [Brave API portal](https://brave.com/search/api/) adresine bakın.
- Search planı LLM Context uç noktasını ve AI çıkarım haklarını içerir. Sonuçları model eğitimi veya ayarlama için depolamak, açık depolama haklarına sahip bir plan gerektirir. Brave [Kullanım Şartları](https://api-dashboard.search.brave.com/terms-of-service) adresine bakın.
- Sonuçlar varsayılan olarak 15 dakika önbelleğe alınır (`cacheTtlMinutes` ile yapılandırılabilir).

Tam web_search yapılandırması için [Web araçları](/tools/web) adresine bakın.
