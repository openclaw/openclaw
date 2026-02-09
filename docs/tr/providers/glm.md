---
summary: "GLM model ailesine genel bakış + OpenClaw'da nasıl kullanılır"
read_when:
  - OpenClaw'da GLM modellerini istiyorsunuz
  - Model adlandırma kuralı ve kurulumuna ihtiyacınız var
title: "GLM Modelleri"
---

# GLM modelleri

GLM, Z.AI platformu üzerinden sunulan bir **model ailesidir** (bir şirket değildir). OpenClaw'da GLM
modellerine `zai` sağlayıcısı ve `zai/glm-4.7` gibi model kimlikleri aracılığıyla erişilir.

## CLI kurulumu

```bash
openclaw onboard --auth-choice zai-api-key
```

## Yapılandırma parçacığı

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notlar

- GLM sürümleri ve kullanılabilirliği değişebilir; en güncel bilgiler için Z.AI belgelerini kontrol edin.
- Örnek model kimlikleri arasında `glm-4.7` ve `glm-4.6` bulunur.
- Sağlayıcı ayrıntıları için bkz. [/providers/zai](/providers/zai).
