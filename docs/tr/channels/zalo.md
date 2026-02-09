---
summary: "Zalo bot destek durumu, yetenekler ve yapılandırma"
read_when:
  - Zalo özellikleri veya web kancaları üzerinde çalışırken
title: "Zalo"
---

# Zalo (Bot API)

Durum: deneysel. Yalnızca doğrudan mesajlar; Zalo belgelerine göre gruplar yakında geliyor.

## Gerekli eklenti

Zalo bir eklenti olarak sunulur ve çekirdek kurulumla birlikte gelmez.

- CLI üzerinden yükleyin: `openclaw plugins install @openclaw/zalo`
- Veya ilk katılım sırasında **Zalo**’yu seçin ve yükleme istemini onaylayın
- Ayrıntılar: [Plugins](/tools/plugin)

## Hızlı kurulum (başlangıç)

1. Zalo eklentisini yükleyin:
   - Kaynak koddan: `openclaw plugins install ./extensions/zalo`
   - npm’den (yayınlandıysa): `openclaw plugins install @openclaw/zalo`
   - Ya da ilk katılımda **Zalo**’yu seçip yükleme istemini onaylayın
2. Belirteci ayarlayın:
   - Env: `ZALO_BOT_TOKEN=...`
   - Ya da yapılandırma: `channels.zalo.botToken: "..."`.
3. Gateway’i yeniden başlatın (veya ilk katılımı tamamlayın).
4. DM erişimi varsayılan olarak eşleştirmedir; ilk temasta eşleştirme kodunu onaylayın.

Minimal yapılandırma:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Nedir

Zalo, Vietnam odaklı bir mesajlaşma uygulamasıdır; Bot API’si, Gateway’nin 1:1 görüşmeler için bir bot çalıştırmasına olanak tanır.
Zalo’ya deterministik yönlendirme istediğiniz destek veya bildirim senaryoları için uygundur.

- Gateway’ye ait bir Zalo Bot API kanalı.
- Deterministik yönlendirme: yanıtlar Zalo’ya geri gider; model kanal seçmez.
- DM’ler ajanın ana oturumunu paylaşır.
- Gruplar henüz desteklenmiyor (Zalo belgelerinde “yakında geliyor” olarak belirtilir).

## Kurulum (hızlı yol)

### 1. Bot belirteci oluşturma (Zalo Bot Platform)

1. [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) adresine gidin ve oturum açın.
2. Yeni bir bot oluşturun ve ayarlarını yapılandırın.
3. Bot belirtecini kopyalayın (format: `12345689:abc-xyz`).

### 2) Belirteci yapılandırma (ortam veya yapılandırma)

Örnek:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Ortam seçeneği: `ZALO_BOT_TOKEN=...` (yalnızca varsayılan hesap için çalışır).

Çoklu hesap desteği: hesap başına belirteçlerle `channels.zalo.accounts` ve isteğe bağlı `name` kullanın.

3. Gateway’i yeniden başlatın. Bir belirteç çözümlendiğinde (ortam veya yapılandırma) Zalo başlar.
4. DM erişimi varsayılan olarak eşleştirmedir. Bot ilk kez temas edildiğinde kodu onaylayın.

## Nasıl çalışır (davranış)

- Gelen iletiler, medya yer tutucularıyla paylaşılan kanal zarfına normalize edilir.
- Yanıtlar her zaman aynı Zalo sohbetine yönlendirilir.
- Varsayılan olarak long-polling; `channels.zalo.webhookUrl` ile web kancası modu kullanılabilir.

## Sınırlar

- Giden metin 2000 karaktere bölünür (Zalo API sınırı).
- Medya indirme/yükleme `channels.zalo.mediaMaxMb` ile sınırlandırılır (varsayılan 5).
- 2000 karakter sınırı akışı daha az kullanışlı kıldığı için streaming varsayılan olarak engellenmiştir.

## Erişim denetimi (DM’ler)

### DM erişimi

- Varsayılan: `channels.zalo.dmPolicy = "pairing"`. Bilinmeyen gönderenler bir eşleştirme kodu alır; onaylanana kadar mesajlar yok sayılır (kodlar 1 saat sonra geçersiz olur).
- Onaylama:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Eşleştirme varsayılan belirteç değişimidir. Ayrıntılar: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` sayısal kullanıcı kimliklerini kabul eder (kullanıcı adı araması yoktur).

## Long-polling ve web kancası karşılaştırması

- Varsayılan: long-polling (herkese açık URL gerekmez).
- Web kancası modu: `channels.zalo.webhookUrl` ve `channels.zalo.webhookSecret` ayarlayın.
  - Web kancası gizli anahtarı 8-256 karakter olmalıdır.
  - Web kancası URL’si HTTPS kullanmalıdır.
  - Zalo, doğrulama için `X-Bot-Api-Secret-Token` başlığıyla olaylar gönderir.
  - Gateway HTTP, web kancası isteklerini `channels.zalo.webhookPath` yolunda karşılar (varsayılan olarak web kancası URL yolunu kullanır).

**Not:** Zalo API belgelerine göre getUpdates (polling) ve web kancası birbirini dışlar.

## Desteklenen mesaj türleri

- **Metin mesajları**: 2000 karaktere bölme ile tam destek.
- **Görüntü mesajları**: Gelen görüntüleri indirip işler; `sendPhoto` ile görüntü gönderir.
- **Çıkartmalar**: Günlüğe alınır ancak tam olarak işlenmez (ajan yanıtı yok).
- **Desteklenmeyen türler**: Günlüğe alınır (ör. korumalı kullanıcılardan gelen mesajlar).

## Capabilities

| Özellik                               | Status                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| Doğrudan mesajlar                     | ✅ Destekleniyor                                         |
| Gruplar                               | ❌ Yakında (Zalo belgelerine göre)    |
| Medya (görüntüler) | ✅ Destekleniyor                                         |
| Tepkiler                              | ❌ Desteklenmiyor                                        |
| Konular                               | ❌ Desteklenmiyor                                        |
| Polls                                 | ❌ Desteklenmiyor                                        |
| Native commands                       | ❌ Desteklenmiyor                                        |
| Streaming                             | ⚠️ Engellendi (2000 karakter sınırı) |

## Teslim hedefleri (CLI/cron)

- Hedef olarak bir sohbet kimliği kullanın.
- Örnek: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Sorun Giderme

**Bot yanıt vermiyor:**

- Belirtecin geçerli olduğunu kontrol edin: `openclaw channels status --probe`
- Gönderenin onaylı olduğunu doğrulayın (eşleştirme veya allowFrom)
- Gateway günlüklerini kontrol edin: `openclaw logs --follow`

**Web kancası olay almıyor:**

- Web kancası URL’sinin HTTPS kullandığından emin olun
- Gizli anahtarın 8-256 karakter olduğunu doğrulayın
- Gateway HTTP uç noktasının yapılandırılan yolda erişilebilir olduğunu onaylayın
- getUpdates polling’in çalışmadığını kontrol edin (birbirini dışlarlar)

## Yapılandırma başvurusu (Zalo)

Tam yapılandırma: [Configuration](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.zalo.enabled`: kanal başlangıcını etkinleştir/devre dışı bırak.
- `channels.zalo.botToken`: Zalo Bot Platform’dan bot belirteci.
- `channels.zalo.tokenFile`: belirteci dosya yolundan oku.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (varsayılan: eşleştirme).
- `channels.zalo.allowFrom`: DM izin listesi (kullanıcı kimlikleri). `open` için `"*"` gerekir. Sihirbaz sayısal kimlikleri ister.
- `channels.zalo.mediaMaxMb`: gelen/giden medya sınırı (MB, varsayılan 5).
- `channels.zalo.webhookUrl`: web kancası modunu etkinleştir (HTTPS gerekli).
- `channels.zalo.webhookSecret`: web kancası gizli anahtarı (8-256 karakter).
- `channels.zalo.webhookPath`: Gateway HTTP sunucusunda web kancası yolu.
- `channels.zalo.proxy`: API istekleri için proxy URL’si.

Çoklu hesap seçenekleri:

- `channels.zalo.accounts.<id>.botToken`: hesap başına belirteç.
- `channels.zalo.accounts.<id>.tokenFile`: hesap başına belirteç dosyası.
- `channels.zalo.accounts.<id>.name`: görünen ad.
- `channels.zalo.accounts.<id>.enabled`: hesabı etkinleştir/devre dışı bırak.
- `channels.zalo.accounts.<id>.dmPolicy`: hesap başına DM politikası.
- `channels.zalo.accounts.<id>.allowFrom`: hesap başına izin listesi.
- `channels.zalo.accounts.<id>.webhookUrl`: hesap başına web kancası URL’si.
- `channels.zalo.accounts.<id>.webhookSecret`: hesap başına web kancası gizli anahtarı.
- `channels.zalo.accounts.<id>.webhookPath`: hesap başına web kancası yolu.
- `channels.zalo.accounts.<id>.proxy`: hesap başına proxy URL’si.
