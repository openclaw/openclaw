---
summary: "OpenClaw ile Xiaomi MiMo (mimo-v2-flash) kullanın"
read_when:
  - OpenClaw’da Xiaomi MiMo modellerini istiyorsunuz
  - XIAOMI_API_KEY kurulumu yapmanız gerekiyor
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo, **MiMo** modelleri için API platformudur. OpenAI ve Anthropic formatlarıyla uyumlu
REST API’ler sunar ve kimlik doğrulama için API anahtarları kullanır. API anahtarınızı
[Xiaomi MiMo konsolunda](https://platform.xiaomimimo.com/#/console/api-keys) oluşturun. OpenClaw,
Xiaomi MiMo API anahtarıyla `xiaomi` sağlayıcısını kullanır.

## Model genel bakış

- **mimo-v2-flash**: 262144 belirteçlik bağlam penceresi, Anthropic Messages API uyumlu.
- Temel URL: `https://api.xiaomimimo.com/anthropic`
- Yetkilendirme: `Bearer $XIAOMI_API_KEY`

## CLI kurulumu

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Yapılandırma parçacığı

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notlar

- Model referansı: `xiaomi/mimo-v2-flash`.
- `XIAOMI_API_KEY` ayarlandığında (veya bir kimlik doğrulama profili mevcutsa) sağlayıcı otomatik olarak enjekte edilir.
- Sağlayıcı kuralları için [/concepts/model-providers](/concepts/model-providers) sayfasına bakın.
