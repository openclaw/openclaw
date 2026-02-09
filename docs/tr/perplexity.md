---
summary: "web_search için Perplexity Sonar kurulumu"
read_when:
  - Web araması için Perplexity Sonar kullanmak istiyorsunuz
  - PERPLEXITY_API_KEY veya OpenRouter kurulumu yapmanız gerekiyor
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw, `web_search` aracı için Perplexity Sonar kullanabilir. Perplexity’nin doğrudan API’si üzerinden veya OpenRouter aracılığıyla bağlanabilirsiniz.

## API seçenekleri

### Perplexity (doğrudan)

- Temel URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Ortam değişkeni: `PERPLEXITY_API_KEY`

### OpenRouter (alternatif)

- Temel URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Ortam değişkeni: `OPENROUTER_API_KEY`
- Ön ödemeli/kripto kredilerini destekler.

## Yapılandırma örneği

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

## Brave’den geçiş

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

Eğer hem `PERPLEXITY_API_KEY` hem de `OPENROUTER_API_KEY` ayarlıysa, ayırt etmek için
`tools.web.search.perplexity.baseUrl` (veya `tools.web.search.perplexity.apiKey`) ayarlayın.

Herhangi bir temel URL ayarlanmamışsa, OpenClaw API anahtarının kaynağına göre bir varsayılan seçer:

- `PERPLEXITY_API_KEY` veya `pplx-...` → doğrudan Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` veya `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Bilinmeyen anahtar biçimleri → OpenRouter (güvenli geri dönüş)

## Modeller

- `perplexity/sonar` — web aramasıyla hızlı Soru-Cevap
- `perplexity/sonar-pro` (varsayılan) — çok adımlı akıl yürütme + web araması
- `perplexity/sonar-reasoning-pro` — derin araştırma

Tam web_search yapılandırması için [Web araçları](/tools/web) bölümüne bakın.
