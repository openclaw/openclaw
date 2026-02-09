---
summary: "Web arama + getirme araçları (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - web_search veya web_fetch’i etkinleştirmek istiyorsunuz
  - Brave Search API anahtarı kurulumuna ihtiyacınız var
  - Web araması için Perplexity Sonar kullanmak istiyorsunuz
title: "Web Araçları"
---

# Web araçları

OpenClaw iki hafif web aracıyla birlikte gelir:

- `web_search` — Brave Search API (varsayılan) veya Perplexity Sonar (doğrudan ya da OpenRouter üzerinden) ile web araması.
- `web_fetch` — HTTP getirme + okunabilir içerik çıkarımı (HTML → markdown/metin).

Bunlar tarayıcı otomasyonu **değildir**. JS ağırlıklı siteler veya giriş gerektiren sayfalar için
[Tarayıcı aracı](/tools/browser) kullanın.

## Nasıl çalışır

- `web_search` yapılandırılmış sağlayıcınızı çağırır ve sonuçları döndürür.
  - **Brave** (varsayılan): yapılandırılmış sonuçlar döndürür (başlık, URL, özet).
  - **Perplexity**: gerçek zamanlı web aramasından alıntılarla AI tarafından sentezlenmiş yanıtlar döndürür.
- Sonuçlar sorguya göre 15 dakika boyunca önbelleğe alınır (yapılandırılabilir).
- `web_fetch` düz bir HTTP GET yapar ve okunabilir içeriği çıkarır
  (HTML → markdown/metin). JavaScript **çalıştırmaz**.
- `web_fetch` varsayılan olarak etkindir (açıkça devre dışı bırakılmadıkça).

## Bir arama sağlayıcısı seçme

| Sağlayıcı                                 | Pros                                             | Cons                                       | API Anahtarı                                   |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------- |
| **Brave** (varsayılan) | Hızlı, yapılandırılmış sonuçlar, ücretsiz katman | Geleneksel arama sonuçları                 | `BRAVE_API_KEY`                                |
| **Perplexity**                            | AI-sentezli yanıtlar, alıntılar, gerçek zamanlı  | Perplexity veya OpenRouter erişimi gerekir | `OPENROUTER_API_KEY` veya `PERPLEXITY_API_KEY` |

Sağlayıcıya özgü ayrıntılar için [Brave Search kurulumu](/brave-search) ve [Perplexity Sonar](/perplexity) sayfalarına bakın.

Sağlayıcıyı yapılandırmada ayarlayın:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Örnek: Perplexity Sonar’a geçiş (doğrudan API):

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave API anahtarı alma

1. [https://brave.com/search/api/](https://brave.com/search/api/) adresinden bir Brave Search API hesabı oluşturun.
2. Kontrol panelinde **Data for Search** planını seçin (“Data for AI” değil) ve bir API anahtarı oluşturun.
3. Anahtarı yapılandırmada saklamak için (önerilir) `openclaw configure --section web` komutunu çalıştırın veya ortamınızda `BRAVE_API_KEY` değişkenini ayarlayın.

Brave ücretsiz bir katman ve ücretli planlar sunar; güncel limitler ve fiyatlandırma için
Brave API portalını kontrol edin.

### Anahtarı nereye ayarlamalı (önerilen)

**Önerilen:** `openclaw configure --section web` komutunu çalıştırın. Bu, anahtarı
`~/.openclaw/openclaw.json` içinde `tools.web.search.apiKey` altında saklar.

**Ortam alternatifi:** Gateway süreci ortamında `BRAVE_API_KEY` ayarlayın. Bir gateway kurulumu için bunu `~/.openclaw/.env` dosyasına (veya servis ortamınıza) ekleyin. Bkz. [Ortam değişkenleri](/help/faq#how-does-openclaw-load-environment-variables).

## Perplexity kullanma (doğrudan veya OpenRouter üzerinden)

Perplexity Sonar modelleri yerleşik web arama yeteneklerine sahiptir ve
alıntılarla AI-sentezli yanıtlar döndürür. Bunları OpenRouter üzerinden
kullanabilirsiniz (kredi kartı gerekmez — kripto/ön ödemeli destekler).

### OpenRouter API anahtarı alma

1. [https://openrouter.ai/](https://openrouter.ai/) adresinde bir hesap oluşturun.
2. Kredi ekleyin (kripto, ön ödemeli veya kredi kartı desteklenir).
3. Hesap ayarlarınızdan bir API anahtarı oluşturun.

### Perplexity aramasını ayarlama

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Ortam alternatifi:** Gateway ortamında `OPENROUTER_API_KEY` veya `PERPLEXITY_API_KEY` ayarlayın. Bir gateway kurulumu için bunu `~/.openclaw/.env` içine koyun.

Bir temel URL ayarlanmazsa, OpenClaw API anahtarı kaynağına göre bir varsayılan seçer:

- `PERPLEXITY_API_KEY` veya `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` veya `sk-or-...` → `https://openrouter.ai/api/v1`
- Bilinmeyen anahtar biçimleri → OpenRouter (güvenli geri dönüş)

### Kullanılabilir Perplexity modelleri

| Model                                                  | Açıklama                               | En uygun kullanım |
| ------------------------------------------------------ | -------------------------------------- | ----------------- |
| `perplexity/sonar`                                     | Web aramasıyla hızlı Soru-Cevap        | Hızlı bakışlar    |
| `perplexity/sonar-pro` (varsayılan) | Web aramasıyla çok adımlı akıl yürütme | Karmaşık sorular  |
| `perplexity/sonar-reasoning-pro`                       | Zincirleme düşünce analizi             | Derin araştırma   |

## web_search

Yapılandırılmış sağlayıcınızı kullanarak web araması yapar.

### Gereksinimler

- `tools.web.search.enabled` `false` olmamalıdır (varsayılan: etkin)
- Seçtiğiniz sağlayıcı için API anahtarı:
  - **Brave**: `BRAVE_API_KEY` veya `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` veya `tools.web.search.perplexity.apiKey`

### Yapılandırma

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Araç parametreleri

- `query` (gerekli)
- `count` (1–10; varsayılan yapılandırmadan)
- `country` (isteğe bağlı): bölgeye özgü sonuçlar için 2 harfli ülke kodu (örn. "DE", "US", "ALL"). Atlanırsa Brave varsayılan bölgesini seçer.
- `search_lang` (isteğe bağlı): arama sonuçları için ISO dil kodu (örn. "de", "en", "fr")
- `ui_lang` (isteğe bağlı): UI öğeleri için ISO dil kodu
- `freshness` (isteğe bağlı, yalnızca Brave): keşif zamanına göre filtreleme (`pd`, `pw`, `pm`, `py` veya `YYYY-MM-DDtoYYYY-MM-DD`)

**Örnekler:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Bir URL’yi getirir ve okunabilir içeriği çıkarır.

### web_fetch gereksinimleri

- `tools.web.fetch.enabled` `false` olmamalıdır (varsayılan: etkin)
- İsteğe bağlı Firecrawl geri dönüşü: `tools.web.fetch.firecrawl.apiKey` veya `FIRECRAWL_API_KEY` ayarlayın.

### web_fetch yapılandırması

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch araç parametreleri

- `url` (gerekli, yalnızca http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (uzun sayfaları kırp)

Notlar:

- `web_fetch` önce Readability’yi (ana içerik çıkarımı) kullanır, ardından (yapılandırılmışsa) Firecrawl’i dener. Her ikisi de başarısız olursa araç bir hata döndürür.
- Firecrawl istekleri bot-atlatma modunu kullanır ve varsayılan olarak sonuçları önbelleğe alır.
- `web_fetch` Chrome benzeri bir User-Agent ve varsayılan olarak `Accept-Language` gönderir; gerekirse `userAgent` ile geçersiz kılın.
- `web_fetch` özel/dahili ana bilgisayar adlarını engeller ve yönlendirmeleri yeniden kontrol eder ( `maxRedirects` ile sınırlandırın).
- `maxChars` `tools.web.fetch.maxCharsCap` değerine sıkıştırılır.
- `web_fetch` en iyi çaba ile çıkarımdır; bazı siteler tarayıcı aracına ihtiyaç duyar.
- Anahtar kurulumu ve hizmet ayrıntıları için [Firecrawl](/tools/firecrawl) sayfasına bakın.
- Yanıtlar, tekrar eden getirmeleri azaltmak için önbelleğe alınır (varsayılan 15 dakika).
- Araç profilleri/izin listeleri kullanıyorsanız, `web_search`/`web_fetch` veya `group:web` ekleyin.
- Brave anahtarı eksikse, `web_search` belgeler bağlantısı içeren kısa bir kurulum ipucu döndürür.
