---
summary: "BlueBubbles macOS sunucusu üzerinden iMessage (REST gönderme/alma, yazıyor göstergeleri, tepkiler, eşleştirme, gelişmiş eylemler)."
read_when:
  - BlueBubbles kanalını kurma
  - Webhook eşleştirme sorunlarını giderme
  - macOS üzerinde iMessage yapılandırma
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Durum: BlueBubbles macOS sunucusuyla HTTP üzerinden konuşan paketlenmiş eklenti. Eski imsg kanalına kıyasla daha zengin API’si ve daha kolay kurulumu nedeniyle **iMessage entegrasyonu için önerilir**.

## Genel bakış

- BlueBubbles yardımcı uygulaması üzerinden macOS’ta çalışır ([bluebubbles.app](https://bluebubbles.app)).
- Önerilen/test edilen: macOS Sequoia (15). macOS Tahoe (26) çalışır; ancak Tahoe’da düzenleme şu anda bozuk ve grup simgesi güncellemeleri başarılı raporlanmasına rağmen senkronize olmayabilir.
- OpenClaw, REST API’si aracılığıyla iletişim kurar (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Gelen mesajlar webhook’lar üzerinden gelir; giden yanıtlar, yazıyor göstergeleri, okundu bilgileri ve tapback’ler REST çağrılarıdır.
- Ekler ve çıkartmalar gelen medya olarak içeri alınır (mümkün olduğunda ajana sunulur).
- Eşleştirme/izin listesi, diğer kanallarla aynı şekilde çalışır (`/channels/pairing` vb.) ve `channels.bluebubbles.allowFrom` + eşleştirme kodları kullanır.
- Tepkiler, Slack/Telegram’daki gibi sistem olayları olarak sunulur; böylece ajanlar yanıtlamadan önce bunlara “atıf” yapabilir.
- Gelişmiş özellikler: düzenleme, geri alma, yanıt zincirleme, mesaj efektleri, grup yönetimi.

## Hızlı başlangıç

1. Mac’inize BlueBubbles sunucusunu kurun ([bluebubbles.app/install](https://bluebubbles.app/install) üzerindeki talimatları izleyin).

2. BlueBubbles yapılandırmasında web API’yi etkinleştirin ve bir parola belirleyin.

3. `openclaw onboard` komutunu çalıştırın ve BlueBubbles’ı seçin ya da elle yapılandırın:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. BlueBubbles webhook’larını gateway’inize yönlendirin (örnek: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Gateway’i başlatın; webhook işleyicisini kaydeder ve eşleştirmeyi başlatır.

## Messages.app’i canlı tutma (VM / başsız kurulumlar)

Bazı macOS VM / sürekli açık kurulumlarda Messages.app “boşta” duruma geçebilir (uygulama açılana/öne getirilene kadar gelen olaylar durur). Basit bir geçici çözüm, **Messages’ı her 5 dakikada bir dürtmek** için AppleScript + LaunchAgent kullanmaktır.

### 1. AppleScript’i kaydedin

Şu adla kaydedin:

- `~/Scripts/poke-messages.scpt`

Örnek betik (etkileşimsiz; odağı çalmaz):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Bir LaunchAgent kurun

Şu adla kaydedin:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notlar:

- Bu görev **her 300 saniyede** ve **oturum açılışında** çalışır.
- İlk çalıştırma macOS **Automation** istemlerini tetikleyebilir (`osascript` → Messages). Bunları LaunchAgent’i çalıştıran aynı kullanıcı oturumunda onaylayın.

Yükleyin:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles, etkileşimli kurulum sihirbazında mevcuttur:

```
openclaw onboard
```

Sihirbaz şunları ister:

- **Sunucu URL’si** (gerekli): BlueBubbles sunucu adresi (örn. `http://192.168.1.100:1234`)
- **Parola** (gerekli): BlueBubbles Sunucu ayarlarından API parolası
- **Webhook yolu** (isteğe bağlı): Varsayılan `/bluebubbles-webhook`
- **DM politikası**: eşleştirme, izin listesi, açık veya devre dışı
- **İzin listesi**: Telefon numaraları, e-postalar veya sohbet hedefleri

BlueBubbles’ı CLI ile de ekleyebilirsiniz:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Erişim denetimi (DM’ler + gruplar)

DM’ler:

- Varsayılan: `channels.bluebubbles.dmPolicy = "pairing"`.
- Bilinmeyen göndericiler bir eşleştirme kodu alır; onaylanana kadar mesajlar yok sayılır (kodlar 1 saat sonra sona erer).
- Onaylama:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Eşleştirme, varsayılan belirteç değişimidir. Ayrıntılar: [Pairing](/channels/pairing)

Gruplar:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (varsayılan: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`, `allowlist` ayarlandığında gruplarda kimin tetikleyebileceğini kontrol eder.

### Bahsetme kapısı (gruplar)

BlueBubbles, iMessage/WhatsApp davranışıyla uyumlu olarak grup sohbetleri için bahsetme kapısını destekler:

- Bahsetmeleri algılamak için `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`) kullanır.
- Bir grup için `requireMention` etkinleştirildiğinde, ajan yalnızca bahsedildiğinde yanıt verir.
- Yetkili göndericilerden gelen kontrol komutları bahsetme kapısını aşar.

Grup bazlı yapılandırma:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Komut geçitleme

- Kontrol komutları (örn. `/config`, `/model`) yetkilendirme gerektirir.
- Komut yetkisini belirlemek için `allowFrom` ve `groupAllowFrom` kullanılır.
- Yetkili göndericiler, gruplarda bahsetme olmadan da kontrol komutlarını çalıştırabilir.

## Yazıyor + okundu bilgileri

- **Yazıyor göstergeleri**: Yanıt üretimi öncesinde ve sırasında otomatik gönderilir.
- **Okundu bilgileri**: `channels.bluebubbles.sendReadReceipts` ile kontrol edilir (varsayılan: `true`).
- **Yazıyor göstergeleri**: OpenClaw yazmaya başlama olaylarını gönderir; BlueBubbles gönderimde veya zaman aşımında yazıyor durumunu otomatik temizler (DELETE ile manuel durdurma güvenilir değildir).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Gelişmiş eylemler

BlueBubbles, yapılandırmada etkinleştirildiğinde gelişmiş mesaj eylemlerini destekler:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Mevcut eylemler:

- **react**: Tapback tepkileri ekle/kaldır (`messageId`, `emoji`, `remove`)
- **edit**: Gönderilmiş bir mesajı düzenle (`messageId`, `text`)
- **unsend**: Bir mesajı geri al (`messageId`)
- **reply**: Belirli bir mesaja yanıt ver (`messageId`, `text`, `to`)
- **sendWithEffect**: iMessage efektiyle gönder (`text`, `to`, `effectId`)
- **renameGroup**: Bir grup sohbetini yeniden adlandır (`chatGuid`, `displayName`)
- **setGroupIcon**: Bir grup sohbetinin simgesini/fotoğrafını ayarla (`chatGuid`, `media`) — macOS 26 Tahoe’da kararsızdır (API başarılı dönebilir ancak simge senkronize olmaz).
- **addParticipant**: Bir gruba kişi ekle (`chatGuid`, `address`)
- **removeParticipant**: Bir gruptan kişi çıkar (`chatGuid`, `address`)
- **leaveGroup**: Bir grup sohbetinden ayrıl (`chatGuid`)
- **sendAttachment**: Medya/dosya gönder (`to`, `buffer`, `filename`, `asVoice`)
  - Sesli notlar: iMessage sesli mesajı olarak göndermek için **MP3** veya **CAF** sesle `asVoice: true` ayarlayın. BlueBubbles, sesli not gönderirken MP3 → CAF dönüşümü yapar.

### Mesaj kimlikleri (kısa vs tam)

OpenClaw, belirteç tasarrufu için _kısa_ mesaj kimliklerini (örn. `1`, `2`) sunabilir.

- `MessageSid` / `ReplyToId` kısa kimlikler olabilir.
- `MessageSidFull` / `ReplyToIdFull` sağlayıcıya ait tam kimlikleri içerir.
- Kısa kimlikler bellektedir; yeniden başlatma veya önbellek tahliyesiyle sona erebilir.
- Eylemler kısa veya tam `messageId` kabul eder; ancak kısa kimlikler artık mevcut değilse hata verir.

Kalıcı otomasyonlar ve depolama için tam kimlikleri kullanın:

- Şablonlar: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Bağlam: Gelen yüklerde `MessageSidFull` / `ReplyToIdFull`

Şablon değişkenleri için [Configuration](/gateway/configuration) sayfasına bakın.

## Blok halinde akış

Yanıtların tek mesaj olarak mı yoksa bloklar halinde mi gönderileceğini kontrol edin:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Medya + sınırlar

- Gelen ekler indirilir ve medya önbelleğinde saklanır.
- Medya üst sınırı `channels.bluebubbles.mediaMaxMb` ile belirlenir (varsayılan: 8 MB).
- Giden metin `channels.bluebubbles.textChunkLimit` değerine bölünür (varsayılan: 4000 karakter).

## Yapılandırma başvurusu

Tam yapılandırma: [Configuration](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.bluebubbles.enabled`: Kanalı etkinleştir/devre dışı bırak.
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API temel URL’si.
- `channels.bluebubbles.password`: API parolası.
- `channels.bluebubbles.webhookPath`: Webhook uç nokta yolu (varsayılan: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (varsayılan: `pairing`).
- `channels.bluebubbles.allowFrom`: DM izin listesi (kullanıcı adları, e-postalar, E.164 numaraları, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (varsayılan: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Grup gönderici izin listesi.
- `channels.bluebubbles.groups`: Grup bazlı yapılandırma (`requireMention` vb.).
- `channels.bluebubbles.sendReadReceipts`: Okundu bilgilerini gönder (varsayılan: `true`).
- `channels.bluebubbles.blockStreaming`: Blok halinde akışı etkinleştir (varsayılan: `false`; akışlı yanıtlar için gereklidir).
- `channels.bluebubbles.textChunkLimit`: Karakter cinsinden giden parça boyutu (varsayılan: 4000).
- `channels.bluebubbles.chunkMode`: `length` (varsayılan) yalnızca `textChunkLimit` aşıldığında böler; `newline` ise uzunluk bölmeden önce boş satırlarda (paragraf sınırlarında) böler.
- `channels.bluebubbles.mediaMaxMb`: MB cinsinden gelen medya üst sınırı (varsayılan: 8).
- `channels.bluebubbles.historyLimit`: Bağlam için maksimum grup mesajı (0 devre dışı bırakır).
- `channels.bluebubbles.dmHistoryLimit`: DM geçmişi sınırı.
- `channels.bluebubbles.actions`: Belirli eylemleri etkinleştir/devre dışı bırak.
- `channels.bluebubbles.accounts`: Çoklu hesap yapılandırması.

İlgili genel seçenekler:

- `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adresleme / teslim hedefleri

Kararlı yönlendirme için `chat_guid` tercih edin:

- `chat_guid:iMessage;-;+15555550123` (gruplar için tercih edilir)
- `chat_id:123`
- `chat_identifier:...`
- Doğrudan tanıtıcılar: `+15555550123`, `user@example.com`
  - Doğrudan bir tanıtıcı için mevcut bir DM sohbeti yoksa, OpenClaw `POST /api/v1/chat/new` aracılığıyla bir tane oluşturur. Bunun için BlueBubbles Private API’nin etkinleştirilmesi gerekir.

## Güvenlik

- Webhook istekleri, `guid`/`password` sorgu parametreleri veya başlıklarının `channels.bluebubbles.password` ile karşılaştırılmasıyla doğrulanır. `localhost` kaynaklı istekler de kabul edilir.
- API parolasını ve webhook uç noktasını gizli tutun (kimlik bilgisi gibi ele alın).
- Localhost güveni, aynı ana makinedeki bir ters proxy’nin parolayı istemeden atlamasına yol açabilir. Gateway’i proxy’liyorsanız, proxy’de kimlik doğrulama zorunlu kılın ve `gateway.trustedProxies` yapılandırın. [Gateway security](/gateway/security#reverse-proxy-configuration).
- Sunucuyu LAN dışına açıyorsanız BlueBubbles sunucusunda HTTPS + güvenlik duvarı kurallarını etkinleştirin.

## Sorun Giderme

- Yazıyor/okundu olayları çalışmayı durdurursa, BlueBubbles webhook günlüklerini kontrol edin ve gateway yolunun `channels.bluebubbles.webhookPath` ile eşleştiğini doğrulayın.
- Eşleştirme kodları bir saat sonra sona erer; `openclaw pairing list bluebubbles` ve `openclaw pairing approve bluebubbles <code>` kullanın.
- Tepkiler için BlueBubbles private API gerekir (`POST /api/v1/message/react`); sunucu sürümünün bunu sunduğundan emin olun.
- Düzenleme/geri alma için macOS 13+ ve uyumlu bir BlueBubbles sunucu sürümü gerekir. macOS 26 (Tahoe)’da private API değişiklikleri nedeniyle düzenleme şu anda bozuk.
- Grup simgesi güncellemeleri macOS 26 (Tahoe)’da kararsız olabilir: API başarılı dönebilir ancak yeni simge senkronize olmaz.
- OpenClaw, BlueBubbles sunucusunun macOS sürümüne göre bilinen bozuk eylemleri otomatik gizler. macOS 26 (Tahoe)’da düzenleme hâlâ görünüyorsa, `channels.bluebubbles.actions.edit=false` ile elle devre dışı bırakın.
- Durum/sağlık bilgileri için: `openclaw status --all` veya `openclaw status --deep`.

Genel kanal iş akışı başvurusu için [Channels](/channels) ve [Plugins](/tools/plugin) kılavuzlarına bakın.
