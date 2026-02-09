---
summary: "web_fetch için Firecrawl yedek seçeneği (anti-bot + önbellekli çıkarım)"
read_when:
  - Firecrawl destekli web çıkarımı istiyorsunuz
  - Bir Firecrawl API anahtarına ihtiyacınız var
  - web_fetch için anti-bot çıkarımı istiyorsunuz
title: "Firecrawl"
---

# Firecrawl

OpenClaw, `web_fetch` için **Firecrawl**’ı yedek bir çıkarım aracı olarak kullanabilir. Bot engellemelerini aşma ve önbellekleme desteği sunan barındırılan bir içerik çıkarım hizmetidir; bu da JS ağırlıklı sitelerde veya düz HTTP isteklerini engelleyen sayfalarda yardımcı olur.

## API anahtarı alma

1. Bir Firecrawl hesabı oluşturun ve bir API anahtarı üretin.
2. Anahtarı yapılandırmaya kaydedin veya gateway ortamında `FIRECRAWL_API_KEY` ayarlayın.

## Firecrawl yapılandırma

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Notlar:

- `firecrawl.enabled`, bir API anahtarı mevcut olduğunda varsayılan olarak true’dur.
- `maxAgeMs`, önbelleğe alınmış sonuçların ne kadar eski olabileceğini (ms) kontrol eder. Varsayılan 2 gündür.

## Gizlilik / bot engelleme aşımı

Firecrawl, bot engellemeyi aşmak için bir **proxy modu** parametresi sunar (`basic`, `stealth` veya `auto`).
OpenClaw, Firecrawl istekleri için her zaman `proxy: "auto"` ile birlikte `storeInCache: true` kullanır.
Proxy belirtilmezse, Firecrawl varsayılan olarak `auto`’a geçer. `auto`, temel bir deneme başarısız olursa gizli proxy’lerle yeniden dener; bu, yalnızca temel kazımaya kıyasla daha fazla kredi kullanabilir.

## `web_fetch`, Firecrawl’ı nasıl kullanır

`web_fetch` çıkarım sırası:

1. Readability (yerel)
2. Firecrawl (yapılandırılmışsa)
3. Temel HTML temizleme (son yedek)

Web araçlarının tam kurulumu için [Web tools](/tools/web) bölümüne bakın.
