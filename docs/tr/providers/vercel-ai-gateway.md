---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway kurulumu (kimlik doğrulama + model seçimi)"
read_when:
  - OpenClaw ile Vercel AI Gateway kullanmak istiyorsunuz
  - API anahtarı ortam değişkenine veya CLI kimlik doğrulama seçeneğine ihtiyacınız var
x-i18n:
  source_path: providers/vercel-ai-gateway.md
  source_hash: 2bf1687c1152c6e1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:34Z
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway), yüzlerce modele tek bir uç nokta üzerinden erişim sağlamak için birleşik bir API sunar.

- Sağlayıcı: `vercel-ai-gateway`
- Kimlik doğrulama: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages uyumlu

## Hızlı Başlangıç

1. API anahtarını ayarlayın (önerilen: Gateway için saklayın):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Varsayılan bir model ayarlayın:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Etkileşimsiz örnek

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Ortam notu

Gateway bir daemon olarak çalışıyorsa (launchd/systemd), `AI_GATEWAY_API_KEY`
değerinin bu süreç tarafından kullanılabilir olduğundan emin olun (örneğin
`~/.openclaw/.env` içinde veya `env.shellEnv` aracılığıyla).
