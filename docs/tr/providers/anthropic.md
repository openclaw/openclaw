---
summary: "OpenClaw içinde API anahtarları veya setup-token kullanarak Anthropic Claude’u kullanın"
read_when:
  - OpenClaw içinde Anthropic modellerini kullanmak istiyorsanız
  - API anahtarları yerine setup-token kullanmak istiyorsanız
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic, **Claude** model ailesini geliştirir ve API üzerinden erişim sağlar.
OpenClaw’da bir API anahtarı veya **setup-token** ile kimlik doğrulama yapabilirsiniz.

## Seçenek A: Anthropic API anahtarı

**En uygun:** standart API erişimi ve kullanıma dayalı faturalandırma.
API anahtarınızı Anthropic Console’da oluşturun.

### CLI kurulumu

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Yapılandırma parçacığı

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw, Anthropic’in prompt caching özelliğini destekler. Bu özellik **yalnızca API içindir**; abonelik kimlik doğrulaması önbellek ayarlarını dikkate almaz.

### Yapılandırma

Model yapılandırmanızda `cacheRetention` parametresini kullanın:

| Değer   | Önbellek Süresi  | Açıklama                                                            |
| ------- | ---------------- | ------------------------------------------------------------------- |
| `none`  | Önbellekleme yok | Prompt caching’i devre dışı bırakır                                 |
| `short` | 5 dakika         | API Anahtarı kimlik doğrulaması için varsayılan                     |
| `long`  | 1 saat           | Genişletilmiş önbellek (beta bayrağı gerektirir) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Varsayılanlar

Anthropic API Anahtarı kimlik doğrulaması kullanıldığında, OpenClaw tüm Anthropic modelleri için otomatik olarak `cacheRetention: "short"` (5 dakikalık önbellek) uygular. Bunu, yapılandırmanızda açıkça `cacheRetention` ayarlayarak geçersiz kılabilirsiniz.

### Eski parametre

Daha eski olan `cacheControlTtl` parametresi geriye dönük uyumluluk için hâlâ desteklenmektedir:

- `"5m"`, `short`’ye eşlenir
- `"1h"`, `long`’e eşlenir

Yeni `cacheRetention` parametresine geçmenizi öneririz.

OpenClaw, Anthropic API istekleri için `extended-cache-ttl-2025-04-11` beta bayrağını içerir;
sağlayıcı başlıklarını geçersiz kılıyorsanız bunu koruyun (bkz. [/gateway/configuration](/gateway/configuration)).

## Seçenek B: Claude setup-token

**En uygun:** Claude aboneliğinizi kullanmak için.

### Setup-token nereden alınır

Setup-token’lar Anthropic Console’dan değil, **Claude Code CLI** tarafından oluşturulur. Bunu **herhangi bir makinede** çalıştırabilirsiniz:

```bash
claude setup-token
```

Belirteci OpenClaw’a yapıştırın (sihirbaz: **Anthropic token (setup-token yapıştır)**) veya gateway ana makinesinde çalıştırın:

```bash
openclaw models auth setup-token --provider anthropic
```

Belirteci farklı bir makinede oluşturduysanız, yapıştırın:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI kurulumu (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Yapılandırma parçası (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notlar

- Setup-token’ı `claude setup-token` ile oluşturup yapıştırın veya gateway ana makinesinde `openclaw models auth setup-token` çalıştırın.
- Claude aboneliğinde “OAuth token refresh failed …” görürseniz, bir setup-token ile yeniden kimlik doğrulaması yapın. Bkz. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Kimlik doğrulama ayrıntıları ve yeniden kullanım kuralları [/concepts/oauth](/concepts/oauth) bölümündedir.

## Sorun Giderme

**401 hataları / belirtecin aniden geçersiz olması**

- Claude abonelik kimlik doğrulaması süresi dolabilir veya iptal edilebilir. `claude setup-token` komutunu yeniden çalıştırın
  ve bunu **gateway ana makinesine** yapıştırın.
- Claude CLI oturumu farklı bir makinedeyse,
  gateway ana makinesinde `openclaw models auth paste-token --provider anthropic` kullanın.

**Sağlayıcı "anthropic" için API anahtarı bulunamadı**

- Kimlik doğrulama **ajan başınadır**. Yeni ajanlar ana ajanın anahtarlarını devralmaz.
- İlgili ajan için onboarding’i yeniden çalıştırın veya
  gateway ana makinesine bir setup-token / API anahtarı yapıştırın, ardından `openclaw models status` ile doğrulayın.

**Profil `anthropic:default` için kimlik bilgileri bulunamadı**

- Hangi kimlik doğrulama profilinin etkin olduğunu görmek için `openclaw models status` çalıştırın.
- Onboarding’i yeniden çalıştırın veya bu profil için bir setup-token / API anahtarı yapıştırın.

**Kullanılabilir kimlik doğrulama profili yok (hepsi cooldown/kullanılamaz)**

- `openclaw models status --json` içinde `auth.unusableProfiles` durumunu kontrol edin.
- Başka bir Anthropic profili ekleyin veya cooldown süresinin dolmasını bekleyin.

Daha fazlası: [/gateway/troubleshooting](/gateway/troubleshooting) ve [/help/faq](/help/faq).
