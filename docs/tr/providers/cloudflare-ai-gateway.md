---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway kurulumu (kimlik doğrulama + model seçimi)"
read_when:
  - OpenClaw ile Cloudflare AI Gateway kullanmak istiyorsunuz
  - Hesap kimliği, gateway kimliği veya API anahtarı ortam değişkenine ihtiyacınız var
---

# Cloudflare AI Gateway

Cloudflare AI Gateway, sağlayıcı API’lerinin önünde yer alır ve analiz, önbellekleme ve denetimler eklemenizi sağlar. Anthropic için OpenClaw, Gateway uç noktanız üzerinden Anthropic Messages API’yi kullanır.

- Sağlayıcı: `cloudflare-ai-gateway`
- Temel URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Varsayılan model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API anahtarı: `CLOUDFLARE_AI_GATEWAY_API_KEY` (Gateway üzerinden yapılan istekler için sağlayıcı API anahtarınız)

Anthropic modelleri için Anthropic API anahtarınızı kullanın.

## Hızlı Başlangıç

1. Sağlayıcı API anahtarını ve Gateway ayrıntılarını ayarlayın:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Varsayılan bir model ayarlayın:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Etkileşimsiz örnek

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Kimlik doğrulamalı gateway’ler

Cloudflare’da Gateway kimlik doğrulamasını etkinleştirdiyseniz, `cf-aig-authorization` üst bilgisini ekleyin (bu, sağlayıcı API anahtarınıza ek olarak gereklidir).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Ortam notu

Gateway bir daemon (launchd/systemd) olarak çalışıyorsa, `CLOUDFLARE_AI_GATEWAY_API_KEY`’un bu süreç tarafından erişilebilir olduğundan emin olun (örneğin, `~/.openclaw/.env` içinde veya `env.shellEnv` aracılığıyla).
