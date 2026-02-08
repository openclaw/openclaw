---
summary: "Birçok modele OpenClaw’da erişmek için Qianfan’ın birleşik API’sini kullanın"
read_when:
  - Birçok LLM için tek bir API anahtarı istiyorsunuz
  - Baidu Qianfan kurulum rehberine ihtiyacınız var
title: "Qianfan"
x-i18n:
  source_path: providers/qianfan.md
  source_hash: 2ca710b422f190b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:36Z
---

# Qianfan Sağlayıcı Kılavuzu

Qianfan, Baidu’nun MaaS platformudur ve tek bir uç nokta ile API anahtarı arkasında birçok modele yönlendiren **birleşik bir API** sunar. OpenAI uyumludur; bu nedenle çoğu OpenAI SDK’sı, temel URL’yi değiştirerek çalışır.

## Ön koşullar

1. Qianfan API erişimine sahip bir Baidu Cloud hesabı
2. Qianfan konsolundan alınmış bir API anahtarı
3. Sisteminizde OpenClaw’ın kurulu olması

## API Anahtarınızı Alma

1. [Qianfan Konsolu](https://console.bce.baidu.com/qianfan/ais/console/apiKey) sayfasını ziyaret edin
2. Yeni bir uygulama oluşturun veya mevcut bir uygulamayı seçin
3. Bir API anahtarı oluşturun (biçim: `bce-v3/ALTAK-...`)
4. OpenClaw ile kullanmak üzere API anahtarını kopyalayın

## CLI kurulumu

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## İlgili Dokümantasyon

- [OpenClaw Yapılandırma](/gateway/configuration)
- [Model Sağlayıcıları](/concepts/model-providers)
- [Ajan Kurulumu](/concepts/agent)
- [Qianfan API Dokümantasyonu](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
