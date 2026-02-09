---
summary: "OpenClaw’da OpenAI’yi API anahtarları veya Codex aboneliği üzerinden kullanın"
read_when:
  - OpenClaw’da OpenAI modellerini kullanmak istiyorsunuz
  - API anahtarları yerine Codex aboneliği ile kimlik doğrulama istiyorsunuz
title: "OpenAI"
---

# OpenAI

OpenAI, GPT modelleri için geliştirici API’leri sunar. Codex, abonelik erişimi için **ChatGPT ile oturum açma** veya kullanıma dayalı erişim için **API anahtarı** ile oturum açmayı destekler. Codex bulutu ChatGPT ile oturum açmayı gerektirir.

## Seçenek A: OpenAI API anahtarı (OpenAI Platformu)

**Şunun için en iyisi:** doğrudan API erişimi ve kullanıma dayalı faturalandırma.
API anahtarınızı OpenAI kontrol panelinden alın.

### CLI kurulumu

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Yapılandırma parçacığı

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Seçenek B: OpenAI Code (Codex) aboneliği

**Şunun için en iyisi:** API anahtarı yerine ChatGPT/Codex abonelik erişimini kullanmak.
Codex bulutu ChatGPT ile oturum açmayı gerektirir; Codex CLI ise ChatGPT veya API anahtarı ile oturum açmayı destekler.

### CLI kurulumu (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Yapılandırma parçası (Codex aboneliği)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notlar

- Model referansları her zaman `provider/model` kullanır (bkz. [/concepts/models](/concepts/models)).
- Kimlik doğrulama ayrıntıları ve yeniden kullanım kuralları [/concepts/oauth](/concepts/oauth) sayfasındadır.
