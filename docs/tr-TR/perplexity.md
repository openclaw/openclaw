---
summary: "web_search için Perplexity Search API ve Sonar/OpenRouter uyumluluğu"
read_when:
  - Web araması için Perplexity Search kullanmak istiyorsanız
  - PERPLEXITY_API_KEY veya OPENROUTER_API_KEY kurulumuna ihtiyacınız varsa
title: "Perplexity Search"
---

# Perplexity Search API

OpenClaw, `web_search` sağlayıcısı olarak Perplexity Search API'yi destekler.
`title`, `url` ve `snippet` alanlarıyla yapılandırılmış sonuçlar döndürür.

Uyumluluk için, OpenClaw eski Perplexity Sonar/OpenRouter kurulumlarını da destekler.
Eğer `OPENROUTER_API_KEY` kullanıyorsanız, `tools.web.search.perplexity.apiKey`'de bir `sk-or-...` anahtarı veya `tools.web.search.perplexity.baseUrl` / `model` ayarladıysanız, sağlayıcı chat-completions yoluna geçer ve yapılandırılmış Search API sonuçları yerine alıntılarla AI-sentezlenmiş yanıtlar döndürür.

## Perplexity API Anahtarı Alma

1. <https://www.perplexity.ai/settings/api> adresinden Perplexity hesabı oluşturun
2. Dashboard'da bir API anahtarı oluşturun
3. Anahtarı config'te saklayın veya Gateway ortamında `PERPLEXITY_API_KEY` ayarlayın.

## OpenRouter Uyumluluğu

Eğer zaten Perplexity Sonar için OpenRouter kullanıyorsanız, `provider: "perplexity"` kullanmaya devam edin ve Gateway ortamında `OPENROUTER_API_KEY` ayarlayın veya `tools.web.search.perplexity.apiKey`'de bir `sk-or-...` anahtarı saklayın.

İsteğe bağlı eski kontroller:

- `tools.web.search.perplexity.baseUrl`
- `tools.web.search.perplexity.model`

## Yapılandırma Örnekleri

### Native Perplexity Search API

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
        },
      },
    },
  },
}
```

### OpenRouter / Sonar Uyumluluğu

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "<openrouter-api-key>",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Anahtarı Nereye Ayarlayın

**Yapılandırma aracılığıyla:** `openclaw configure --section web` komutunu çalıştırın.
Anahtarı `~/.openclaw/openclaw.json` dosyasında `tools.web.search.perplexity.apiKey` altına saklar.
Bu alan SecretRef nesnelerini de kabul eder.

**Ortam değişkeni aracılığıyla:** Gateway process ortamında `PERPLEXITY_API_KEY` veya `OPENROUTER_API_KEY` ayarlayın.
Bir gateway kurulumu için, `~/.openclaw/.env` dosyasına ekleyin (veya servis ortamınıza). Bkz. [Ortam değişkenleri](/help/faq#how-does-openclaw-load-environment-variables).

Eğer `provider: "perplexity"` yapılandırılmışsa ve Perplexity anahtar SecretRef çözümlenememişse ve env fallback yoksa, başlatma/hatalı yeniden yükleme hızlı başarısız olur.

## Araç Parametreleri

Bu parametreler native Perplexity Search API yolu için geçerlidir.

| Parametre             | Açıklama                                          |
| --------------------- | ---------------------------------------------------- |
| `query`               | Arama sorgusu (gerekli)                              |
| `count`               | Döndürülecek sonuç sayısı (1-10, varsayılan: 5)       |
| `country`             | 2 harfli ISO ülke kodu (örn. "US", "DE")         |
| `language`            | ISO 639-1 dil kodu (örn. "en", "de", "fr")     |
| `freshness`           | Zaman filtresi: `day` (24s), `week`, `month`, veya `year` |
| `date_after`          | Yalnızca bu tarihten sonra yayınlanan sonuçlar (YYYY-AA-GG)  |
| `date_before`         | Yalnızca bu tarihten önce yayınlanan sonuçlar (YYYY-AA-GG) |
| `domain_filter`       | Domain izin/red listesi dizisi (maks 20)             |
| `max_tokens`          | Toplam içerik bütçesi (varsayılan: 25000, maks: 1000000)  |
| `max_tokens_per_page` | Sayfa başına token limiti (varsayılan: 2048)                 |

Eski Sonar/OpenRouter uyumluluk yolu için, yalnızca `query` ve `freshness` desteklenir.
`country`, `language`, `date_after`, `date_before`, `domain_filter`, `max_tokens` ve `max_tokens_per_page` gibi yalnızca Search API filtreleri açık hatalar döndürür.

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

// Domain filtreleme (izin listesi)
await web_search({
  query: "iklim araştırması",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Domain filtreleme (red listesi - ile önek)
await web_search({
  query: "ürün incelemeleri",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// Daha fazla içerik çıkarma
await web_search({
  query: "detaylı AI araştırması",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### Domain Filtre Kuralları

- Filtre başına maksimum 20 domain
- Aynı istekte izin ve red listesini karıştıramazsınız
- Red listesi girdileri için `-` öneki kullanın (örn. `["-reddit.com"]`)

## Notlar

- Perplexity Search API yapılandırılmış web arama sonuçları döndürür (`title`, `url`, `snippet`)
- OpenRouter veya açık `baseUrl` / `model`, Perplexity'i uyumluluk için Sonar chat completions'a geri değiştirir
- Sonuçlar varsayılan olarak 15 dakika önbelleğe alınır (`cacheTtlMinutes` ile yapılandırılabilir)

Tam web_search yapılandırması için [Web araçları](/tools/web) adresine bakın.
Daha fazla bilgi için [Perplexity Search API belgeleri](https://docs.perplexity.ai/docs/search/quickstart) adresine bakın.
