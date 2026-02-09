---
summary: "OpenClaw ile OpenCode Zen’i (küratörlü modeller) kullanın"
read_when:
  - Model erişimi için OpenCode Zen istiyorsunuz
  - Kodlamaya uygun modellerden oluşan küratörlü bir liste istiyorsunuz
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen, OpenCode ekibi tarafından kodlama ajanları için önerilen **küratörlü bir model listesidir**.
Bir API anahtarı ve `opencode` sağlayıcısını kullanan, isteğe bağlı ve barındırılan bir model erişim yoludur.
Zen şu anda beta aşamasındadır.

## CLI kurulumu

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Yapılandırma parçacığı

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notlar

- `OPENCODE_ZEN_API_KEY` de desteklenmektedir.
- Zen’e giriş yapar, faturalandırma ayrıntılarını eklersiniz ve API anahtarınızı kopyalarsınız.
- OpenCode Zen istek başına faturalandırır; ayrıntılar için OpenCode panosunu kontrol edin.
