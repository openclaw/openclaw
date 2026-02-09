---
summary: "Kanal başına hata imzaları ve düzeltmelerle hızlı kanal düzeyi sorun giderme"
read_when:
  - Kanal taşıması bağlı diyor ancak yanıtlar başarısız
  - Sağlayıcı belgelerine derinlemesine geçmeden önce kanala özgü kontroller gerekir
title: "Kanal Sorun Giderme"
---

# Kanal sorun giderme

Bir kanal bağlanıyor ancak davranış hatalıysa bu sayfayı kullanın.

## Komut merdiveni

Önce bunları sırayla çalıştırın:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sağlıklı temel durum:

- `Runtime: running`
- `RPC probe: ok`
- Kanal probu bağlı/hazır gösterir

## WhatsApp

### WhatsApp hata imzaları

| Belirti                                | En hızlı kontrol                                                      | Çözüm                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bağlı ancak DM yanıtları yok           | `openclaw pairing list whatsapp`                                      | Göndereni onaylayın veya DM politikasını/izin listesini değiştirin.             |
| Grup mesajları yok sayılıyor           | Yapılandırmadaki `requireMention` + bahsetme kalıplarını kontrol edin | Botu etiketleyin veya o grup için bahsetme politikasını gevşetin.               |
| Rastgele kopma/yeniden giriş döngüleri | `openclaw channels status --probe` + günlükler                        | Yeniden giriş yapın ve kimlik bilgileri dizininin sağlıklı olduğunu doğrulayın. |

Ayrıntılı sorun giderme: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram hata imzaları

| Symptom                                       | En hızlı kontrol                                         | Çözüm                                                                                           |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/start` ancak kullanılabilir yanıt akışı yok | `openclaw pairing list telegram`                         | Eşleştirmeyi onaylayın veya DM politikasını değiştirin.                         |
| Bot çevrimiçi ama grup sessiz                 | Bahsetme gereksinimini ve bot gizlilik modunu doğrulayın | Grup görünürlüğü için gizlilik modunu devre dışı bırakın veya botu etiketleyin. |
| Send failures with network errors             | Telegram API çağrı hataları için günlükleri inceleyin    | DNS/IPv6/proxy yönlendirmesini `api.telegram.org` için düzeltin.                |

Ayrıntılı sorun giderme: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord hata imzaları

| Symptom                            | En hızlı kontrol                    | Çözüm                                                                                     |
| ---------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Bot çevrimiçi ama guild yanıtı yok | `openclaw channels status --probe`  | Guild/kanala izin verin ve mesaj içeriği intent'ini doğrulayın.           |
| Grup mesajları yok sayılıyor       | Check logs for mention gating drops | Botu etiketleyin veya guild/kanal için `requireMention: false` ayarlayın. |
| DM yanıtları eksik                 | `openclaw pairing list discord`     | DM eşleştirmesini onaylayın veya DM politikasını ayarlayın.               |

Ayrıntılı sorun giderme: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack hata imzaları

| Symptom                         | En hızlı kontrol                                   | Çözüm                                                                                |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Socket modu bağlı ama yanıt yok | `openclaw channels status --probe`                 | Uygulama belirteci + bot belirteci ve gerekli kapsamları doğrulayın. |
| DM'ler engelli                  | `openclaw pairing list slack`                      | Eşleştirmeyi onaylayın veya DM politikasını gevşetin.                |
| Kanal mesajı yok sayılıyor      | `groupPolicy` ve kanal izin listesini kontrol edin | Kanalı izin verin veya politikayı `open` olarak değiştirin.          |

Ayrıntılı sorun giderme: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage ve BlueBubbles

### iMessage ve BlueBubbles hata imzaları

| Symptom                             | En hızlı kontrol                                                          | Çözüm                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Gelen olay yok                      | Webhook/sunucu erişilebilirliğini ve uygulama izinlerini doğrulayın       | Webhook URL'sini veya BlueBubbles sunucu durumunu düzeltin.      |
| Gönderiliyor ama macOS'ta alınmıyor | Messages otomasyonu için macOS gizlilik izinlerini kontrol edin           | TCC izinlerini yeniden verin ve kanal sürecini yeniden başlatın. |
| DM göndereni engelli                | `openclaw pairing list imessage` veya `openclaw pairing list bluebubbles` | Eşleştirmeyi onaylayın veya izin listesini güncelleyin.          |

Ayrıntılı sorun giderme:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal hata imzaları

| Symptom                            | En hızlı kontrol                                       | Çözüm                                                                    |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Daemon erişilebilir ama bot sessiz | `openclaw channels status --probe`                     | `signal-cli` daemon URL/hesap ve alma modunu doğrulayın. |
| DM engelli                         | `openclaw pairing list signal`                         | Göndereni onaylayın veya DM politikasını ayarlayın.      |
| Grup yanıtları tetiklenmiyor       | Grup izin listesi ve bahsetme kalıplarını kontrol edin | Göndereni/grubu ekleyin veya kapılamayı gevşetin.        |

Ayrıntılı sorun giderme: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix hata imzaları

| Belirti                                        | En hızlı kontrol                                   | Çözüm                                                                                       |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Giriş yapılmış ama oda mesajlarını yok sayıyor | `openclaw channels status --probe`                 | `groupPolicy` ve oda izin listesini kontrol edin.                           |
| DM'ler işlenmiyor                              | `openclaw pairing list matrix`                     | Göndereni onaylayın veya DM politikasını ayarlayın.                         |
| Şifreli odalar başarısız                       | Kripto modülünü ve şifreleme ayarlarını doğrulayın | Şifreleme desteğini etkinleştirin ve odaya yeniden katılın/senkronize edin. |

Ayrıntılı sorun giderme: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
