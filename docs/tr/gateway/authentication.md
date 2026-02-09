---
summary: "Model kimlik doğrulaması: OAuth, API anahtarları ve setup-token"
read_when:
  - Model kimlik doğrulaması veya OAuth süresinin dolmasını hata ayıklarken
  - Kimlik doğrulama veya kimlik bilgisi depolamayı belgelendirirken
title: "Kimlik Doğrulama"
---

# Kimlik Doğrulama

OpenClaw, model sağlayıcıları için OAuth ve API anahtarlarını destekler. Anthropic
hesapları için **API anahtarı** kullanmanızı öneririz. Claude abonelik erişimi için,
`claude setup-token` tarafından oluşturulan uzun ömürlü belirteci kullanın.

OAuth akışının tamamı ve depolama düzeni için
[/concepts/oauth](/concepts/oauth) sayfasına bakın.

## Önerilen Anthropic kurulumu (API anahtarı)

Anthropic’i doğrudan kullanıyorsanız bir API anahtarı kullanın.

1. Anthropic Console’da bir API anahtarı oluşturun.
2. Bunu **gateway ana makinesine** ( `openclaw gateway` çalıştıran makine) ekleyin.

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gateway systemd/launchd altında çalışıyorsa, anahtarın
   `~/.openclaw/.env` içine konmasını tercih edin; böylece daemon anahtarı okuyabilir:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Ardından daemon’u (veya Gateway sürecinizi) yeniden başlatın ve tekrar kontrol edin:

```bash
openclaw models status
openclaw doctor
```

Ortam değişkenlerini kendiniz yönetmek istemiyorsanız, başlangıç sihirbazı
API anahtarlarını daemon kullanımı için depolayabilir: `openclaw onboard`.

Ortam devralımıyla ilgili ayrıntılar için [Help](/help) sayfasına bakın
(`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (abonelik kimlik doğrulaması)

Anthropic için önerilen yol **API anahtarıdır**. Claude aboneliği kullanıyorsanız,
setup-token akışı da desteklenir. **Gateway ana makinesinde** çalıştırın:

```bash
claude setup-token
```

Ardından bunu OpenClaw’a yapıştırın:

```bash
openclaw models auth setup-token --provider anthropic
```

Belirteç başka bir makinede oluşturulduysa, manuel olarak yapıştırın:

```bash
openclaw models auth paste-token --provider anthropic
```

Aşağıdakine benzer bir Anthropic hatası görürseniz:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…bunun yerine bir Anthropic API anahtarı kullanın.

Manuel belirteç girişi (herhangi bir sağlayıcı; `auth-profiles.json` yazar + yapılandırmayı günceller):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Otomasyona uygun kontrol (süresi dolmuş/eksikse çıkış `1`, süresi dolmak üzereyse `2`):

```bash
openclaw models status --check
```

İsteğe bağlı ops betikleri (systemd/Termux) burada belgelenmiştir:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` etkileşimli bir TTY gerektirir.

## Model kimlik doğrulama durumunu kontrol etme

```bash
openclaw models status
openclaw doctor
```

## Controlling which credential is used

### Oturum başına (sohbet komutu)

Geçerli oturum için belirli bir sağlayıcı kimlik bilgisini sabitlemek üzere
`/model <alias-or-id>@<profileId>` kullanın (örnek profil kimlikleri: `anthropic:default`, `anthropic:work`).

Kompakt bir seçici için `/model` (veya `/model list`) kullanın; tam görünüm
(işaret adayları + sonraki kimlik doğrulama profili, ayrıca yapılandırıldığında
sağlayıcı uç nokta ayrıntıları) için `/model status` kullanın.

### Per-agent (CLI override)

Bir ajan için açık bir kimlik doğrulama profili sırası geçersiz kılması ayarlayın
(ajanın `auth-profiles.json` dosyasında saklanır):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Belirli bir ajanı hedeflemek için `--agent <id>` kullanın; yapılandırılmış varsayılan
ajanı kullanmak için bunu atlayın.

## Sorun Giderme

### “Kimlik bilgisi bulunamadı”

Anthropic belirteç profili eksikse, **gateway ana makinesinde**
`claude setup-token` çalıştırın, ardından tekrar kontrol edin:

```bash
openclaw models status
```

### Belirtecin süresi doluyor/doldu

Hangi profilin süresinin dolduğunu doğrulamak için `openclaw models status` çalıştırın. Profil eksikse, `claude setup-token` komutunu yeniden çalıştırın ve belirteci tekrar yapıştırın.

## Gereksinimler

- Claude Max veya Pro aboneliği (`claude setup-token` için)
- Claude Code CLI yüklü (`claude` komutu mevcut)
