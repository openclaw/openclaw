---
summary: "OpenClaw ile Z.AI (GLM modelleri) kullanın"
read_when:
  - OpenClaw içinde Z.AI / GLM modellerini istiyorsanız
  - Basit bir ZAI_API_KEY kurulumu gerekiyorsa
title: "Z.AI"
---

# Z.AI

Z.AI, **GLM** modelleri için API platformudur. GLM için REST API’leri sağlar ve
kimlik doğrulama için API anahtarları kullanır. API anahtarınızı Z.AI konsolunda oluşturun. OpenClaw,
Z.AI API anahtarıyla birlikte `zai` sağlayıcısını kullanır.

## CLI kurulumu

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Yapılandırma parçacığı

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notlar

- GLM modelleri `zai/<model>` olarak kullanılabilir (örnek: `zai/glm-4.7`).
- Model ailesine genel bakış için [/providers/glm](/providers/glm) sayfasına bakın.
- Z.AI, API anahtarınızla Bearer kimlik doğrulaması kullanır.
