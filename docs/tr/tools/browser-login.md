---
summary: "Tarayıcı otomasyonu + X/Twitter gönderimi için manuel girişler"
read_when:
  - Tarayıcı otomasyonu için sitelere giriş yapmanız gerektiğinde
  - X/Twitter’a güncelleme göndermek istediğinizde
title: "Tarayıcı Girişi"
---

# Tarayıcı girişi + X/Twitter gönderimi

## Manuel giriş (önerilir)

Bir site giriş gerektirdiğinde, **host** tarayıcı profilinde (**openclaw** tarayıcısı) **manuel olarak oturum açın**.

Modelle kimlik bilgilerinizi **paylaşmayın**. Otomatik girişler sıklıkla anti‑bot savunmalarını tetikler ve hesabın kilitlenmesine yol açabilir.

Ana tarayıcı belgelerine geri dönün: [Browser](/tools/browser).

## Hangi Chrome profili kullanılıyor?

OpenClaw, **özel bir Chrome profilini** kontrol eder (adı `openclaw`, turuncu tonlu arayüz). Bu, günlük tarayıcı profilinizden ayrıdır.

Erişmenin iki kolay yolu vardır:

1. **Ajanın tarayıcıyı açmasını isteyin** ve ardından kendiniz giriş yapın.
2. **CLI üzerinden açın**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Birden fazla profiliniz varsa `--browser-profile <name>` iletin (varsayılan `openclaw`’tir).

## X/Twitter: önerilen akış

- **Okuma/arama/iş parçacıkları:** **host** tarayıcıyı kullanın (manuel giriş).
- **Güncelleme gönderme:** **host** tarayıcıyı kullanın (manuel giriş).

## Sandboxing + host tarayıcı erişimi

Sandboxed tarayıcı oturumlarının bot tespitini tetikleme olasılığı **daha yüksektir**. X/Twitter (ve diğer katı siteler) için **host** tarayıcıyı tercih edin.

Ajan sandboxed ise, tarayıcı aracı varsayılan olarak sandbox’ı kullanır. Host denetimine izin vermek için:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Ardından host tarayıcıyı hedefleyin:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Ya da güncelleme gönderen ajan için sandboxing’i devre dışı bırakın.
