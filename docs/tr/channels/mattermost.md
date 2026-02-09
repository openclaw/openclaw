---
summary: "Mattermost bot kurulumu ve OpenClaw yapılandırması"
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: "Mattermost"
---

# Mattermost (eklenti)

Durum: eklenti üzerinden desteklenir (bot belirteci + WebSocket olayları). Kanallar, gruplar ve DM'ler desteklenir.
Mattermost, kendi kendine barındırılabilen bir ekip mesajlaşma platformudur; ürün ayrıntıları ve indirmeler için
resmî siteye bakın:
[mattermost.com](https://mattermost.com).

## Eklenti gereklidir

Mattermost bir eklenti olarak gelir ve çekirdek kurulumla birlikte gelmez.

CLI ile yükleme (npm kayıt defteri):

```bash
openclaw plugins install @openclaw/mattermost
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/mattermost
```

Yapılandırma/onboarding sırasında Mattermost'u seçerseniz ve bir git checkout algılanırsa,
OpenClaw yerel yükleme yolunu otomatik olarak sunar.

Ayrıntılar: [Plugins](/tools/plugin)

## Hızlı kurulum

1. Mattermost eklentisini yükleyin.
2. Bir Mattermost bot hesabı oluşturun ve **bot belirtecini** kopyalayın.
3. Mattermost **temel URL**'sini kopyalayın (ör. `https://chat.example.com`).
4. OpenClaw'ı yapılandırın ve gateway'i başlatın.

Asgari yapılandırma:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Environment variables (default account)

Ortam değişkenlerini tercih ediyorsanız bunları gateway ana makinesinde ayarlayın:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Ortam değişkenleri yalnızca **varsayılan** hesap için geçerlidir (`default`). Diğer hesaplar yapılandırma değerlerini kullanmalıdır.

## Chat modes

Mattermost DM'lere otomatik olarak yanıt verir. Kanal davranışı `chatmode` ile denetlenir:

- `oncall` (varsayılan): kanallarda yalnızca @etiketlendiğinde yanıt verir.
- `onmessage`: her kanal mesajına yanıt verir.
- `onchar`: bir mesaj tetikleyici bir önekle başladığında yanıt verir.

Yapılandırma örneği:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notlar:

- `onchar` açık @etiketlemelere yine de yanıt verir.
- `channels.mattermost.requireMention` eski yapılandırmalar için desteklenir, ancak `chatmode` tercih edilir.

## Erişim denetimi (DM'ler)

- Varsayılan: `channels.mattermost.dmPolicy = "pairing"` (bilinmeyen gönderenler bir eşleştirme kodu alır).
- Onaylama yolları:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Herkese açık DM'ler: `channels.mattermost.dmPolicy="open"` artı `channels.mattermost.allowFrom=["*"]`.

## Kanallar (gruplar)

- Varsayılan: `channels.mattermost.groupPolicy = "allowlist"` (etiketlemeye bağlı).
- Gönderenleri izin listesine almak için `channels.mattermost.groupAllowFrom` kullanın (kullanıcı kimlikleri veya `@username`).
- Açık kanallar: `channels.mattermost.groupPolicy="open"` (etiketlemeye bağlı).

## Giden teslimat için hedefler

Bu hedef biçimlerini `openclaw message send` veya cron/webhook'lar ile kullanın:

- Bir kanal için `channel:<id>`
- Bir DM için `user:<id>`
- Bir DM için `@username` (Mattermost API üzerinden çözümlenir)

Yalın kimlikler kanal olarak değerlendirilir.

## Çoklu hesap

Mattermost, `channels.mattermost.accounts` altında birden fazla hesabı destekler:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Sorun Giderme

- Kanallarda yanıt yok: botun kanalda olduğundan emin olun ve onu etiketleyin (oncall), bir tetikleyici önek kullanın (onchar) veya `chatmode: "onmessage"` ayarlayın.
- Kimlik doğrulama hataları: bot belirtecini, temel URL'yi ve hesabın etkin olup olmadığını kontrol edin.
- Çoklu hesap sorunları: ortam değişkenleri yalnızca `default` hesabına uygulanır.
