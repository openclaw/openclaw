---
summary: "Nextcloud Talk destek durumu, yetenekler ve yapılandırma"
read_when:
  - Nextcloud Talk kanal özellikleri üzerinde çalışırken
title: "Nextcloud Talk"
---

# Nextcloud Talk (eklenti)

Durum: eklenti (webhook botu) üzerinden desteklenir. Doğrudan mesajlar, odalar, tepkiler ve markdown mesajları desteklenir.

## Gerekli eklenti

Nextcloud Talk bir eklenti olarak gelir ve çekirdek kurulumla birlikte sunulmaz.

CLI üzerinden kurulum (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Yapılandırma/onboarding sırasında Nextcloud Talk’ı seçerseniz ve bir git checkout algılanırsa,
OpenClaw yerel kurulum yolunu otomatik olarak sunar.

Ayrıntılar: [Plugins](/tools/plugin)

## Hızlı kurulum (başlangıç seviyesi)

1. Nextcloud Talk eklentisini yükleyin.

2. Nextcloud sunucunuzda bir bot oluşturun:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Hedef oda ayarlarında botu etkinleştirin.

4. OpenClaw’ı yapılandırın:
   - Yapılandırma: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Veya ortam değişkeni: `NEXTCLOUD_TALK_BOT_SECRET` (yalnızca varsayılan hesap)

5. Gateway’i yeniden başlatın (veya onboarding’i tamamlayın).

Minimal yapılandırma:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notlar

- Botlar DM başlatamaz. Kullanıcının önce bota mesaj atması gerekir.
- Webhook URL’si Gateway tarafından erişilebilir olmalıdır; bir proxy arkasındaysa `webhookPublicUrl` ayarlayın.
- Medya yüklemeleri bot API’si tarafından desteklenmez; medya URL olarak gönderilir.
- Webhook yükü DM’ler ile odaları ayırt etmez; oda türü sorgularını etkinleştirmek için `apiUser` + `apiPassword` ayarlayın (aksi halde DM’ler oda olarak değerlendirilir).

## Erişim denetimi (DM’ler)

- Varsayılan: `channels.nextcloud-talk.dmPolicy = "pairing"`. Bilinmeyen gönderenler bir eşleştirme kodu alır.
- Onaylama yolları:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Herkese açık DM’ler: `channels.nextcloud-talk.dmPolicy="open"` artı `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` yalnızca Nextcloud kullanıcı kimlikleriyle eşleşir; görünen adlar yok sayılır.

## Odalar (gruplar)

- Varsayılan: `channels.nextcloud-talk.groupPolicy = "allowlist"` (bahsetme ile kapılı).
- Odaları `channels.nextcloud-talk.rooms` ile izin listesine alın:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Hiç oda izin vermemek için izin listesini boş bırakın veya `channels.nextcloud-talk.groupPolicy="disabled"` ayarlayın.

## Capabilities

| Özellik           | Status        |
| ----------------- | ------------- |
| Doğrudan mesajlar | Destekleniyor |
| Odalar            | Destekleniyor |
| Konular           | Desteklenmez  |
| Medya             | Yalnızca URL  |
| Tepkiler          | Destekleniyor |
| Native commands   | Desteklenmez  |

## Yapılandırma referansı (Nextcloud Talk)

Tüm yapılandırma: [Configuration](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.nextcloud-talk.enabled`: kanal başlangıcını etkinleştir/devre dışı bırak.
- `channels.nextcloud-talk.baseUrl`: Nextcloud örnek URL’si.
- `channels.nextcloud-talk.botSecret`: bot paylaşılan gizli anahtarı.
- `channels.nextcloud-talk.botSecretFile`: gizli anahtar dosya yolu.
- `channels.nextcloud-talk.apiUser`: oda sorguları için API kullanıcısı (DM algılama).
- `channels.nextcloud-talk.apiPassword`: oda sorguları için API/uygulama parolası.
- `channels.nextcloud-talk.apiPasswordFile`: API parola dosya yolu.
- `channels.nextcloud-talk.webhookPort`: webhook dinleyici portu (varsayılan: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook ana makinesi (varsayılan: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook yolu (varsayılan: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: dışarıdan erişilebilir webhook URL’si.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM izin listesi (kullanıcı kimlikleri). `open`, `"*"` gerektirir.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: grup izin listesi (kullanıcı kimlikleri).
- `channels.nextcloud-talk.rooms`: oda başına ayarlar ve izin listesi.
- `channels.nextcloud-talk.historyLimit`: grup geçmişi sınırı (0 devre dışı bırakır).
- `channels.nextcloud-talk.dmHistoryLimit`: DM geçmişi sınırı (0 devre dışı bırakır).
- `channels.nextcloud-talk.dms`: DM başına geçersiz kılmalar (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: giden metin parça boyutu (karakter).
- `channels.nextcloud-talk.chunkMode`: `length` (varsayılan) veya uzunluk parçalamasından önce boş satırlara (paragraf sınırları) göre bölmek için `newline`.
- `channels.nextcloud-talk.blockStreaming`: bu kanal için blok halinde akışı devre dışı bırak.
- `channels.nextcloud-talk.blockStreamingCoalesce`: blok halinde akış birleştirme ayarı.
- `channels.nextcloud-talk.mediaMaxMb`: gelen medya üst sınırı (MB).
