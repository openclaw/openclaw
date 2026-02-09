---
summary: "Matrix destek durumu, yetenekler ve yapılandırma"
read_when:
  - Matrix kanal özellikleri üzerinde çalışırken
title: "Matrix"
---

# Matrix (eklenti)

Matrix açık ve merkeziyetsiz bir mesajlaşma protokolüdür. OpenClaw, herhangi bir homeserver üzerinde bir Matrix **kullanıcısı**
olarak bağlanır; bu nedenle bot için bir Matrix hesabına ihtiyacınız vardır. Giriş yaptıktan sonra
botla doğrudan DM başlatabilir veya onu odalara (Matrix “grupları”) davet edebilirsiniz. Beeper da geçerli bir istemci seçeneğidir,
ancak E2EE’nin etkin olmasını gerektirir.

Durum: eklenti aracılığıyla desteklenir (@vector-im/matrix-bot-sdk). Doğrudan mesajlar, odalar, thread’ler, medya, tepkiler,
anketler (gönderme + anket başlatmayı metin olarak), konum ve E2EE (kriptografi desteğiyle).

## Gerekli eklenti

Matrix bir eklenti olarak sunulur ve çekirdek kurulumla birlikte gelmez.

CLI ile kurulum (npm registry):

```bash
openclaw plugins install @openclaw/matrix
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/matrix
```

Yapılandırma/ilk kurulum sırasında Matrix’i seçerseniz ve bir git checkout algılanırsa,
OpenClaw yerel kurulum yolunu otomatik olarak sunar.

Ayrıntılar: [Eklentiler](/tools/plugin)

## Kurulum

1. Matrix eklentisini yükleyin:
   - npm’den: `openclaw plugins install @openclaw/matrix`
   - Yerel checkout’tan: `openclaw plugins install ./extensions/matrix`

2. Bir homeserver üzerinde bir Matrix hesabı oluşturun:
   - Barındırma seçeneklerine göz atın: [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Ya da kendiniz barındırın.

3. Bot hesabı için bir erişim belirteci alın:

   - Homeserver’ınızda `curl` ile Matrix giriş API’sini kullanın:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org` yerine homeserver URL’nizi yazın.
   - Ya da `channels.matrix.userId` + `channels.matrix.password` ayarlayın: OpenClaw aynı
     giriş uç noktasını çağırır, erişim belirtecini `~/.openclaw/credentials/matrix/credentials.json` içinde saklar
     ve bir sonraki başlatmada yeniden kullanır.

4. Kimlik bilgilerini yapılandırın:
   - Ortam: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (veya `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Ya da yapılandırma: `channels.matrix.*`
   - Her ikisi de ayarlıysa yapılandırma önceliklidir.
   - Erişim belirteciyle: kullanıcı kimliği `/whoami` üzerinden otomatik olarak alınır.
   - Ayarlandığında `channels.matrix.userId` tam Matrix kimliği olmalıdır (örnek: `@bot:example.org`).

5. Gateway’i yeniden başlatın (ya da ilk kurulumu tamamlayın).

6. Herhangi bir Matrix istemcisinden botla DM başlatın veya onu bir odaya davet edin
   (Element, Beeper vb.; bkz. [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper E2EE gerektirir,
   bu nedenle `channels.matrix.encryption: true` ayarlayın ve cihazı doğrulayın.

Asgari yapılandırma (erişim belirteci, kullanıcı kimliği otomatik alınır):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE yapılandırması (uçtan uca şifreleme etkin):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Şifreleme (E2EE)

Uçtan uca şifreleme, Rust kripto SDK’sı üzerinden **desteklenir**.

`channels.matrix.encryption: true` ile etkinleştirin:

- Kripto modülü yüklenirse, şifreli odalar otomatik olarak çözümlenir.
- Şifreli odalara gönderimde giden medya şifrelenir.
- İlk bağlantıda OpenClaw, diğer oturumlarınızdan cihaz doğrulaması ister.
- Anahtar paylaşımını etkinleştirmek için başka bir Matrix istemcisinde (Element vb.) cihazı doğrulayın. to enable key sharing.
- Kripto modülü yüklenemezse E2EE devre dışı bırakılır ve şifreli odalar çözümlenmez;
  OpenClaw bir uyarı günlüğe yazar.
- Eksik kripto modülü hataları görürseniz (örneğin `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  `@matrix-org/matrix-sdk-crypto-nodejs` için derleme betiklerine izin verin ve
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` çalıştırın veya ikiliyi
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` ile alın.

Kripto durumu, hesap + erişim belirteci başına
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite veritabanı) içinde saklanır. Senkronizasyon durumu bunun yanında `bot-storage.json` konumunda bulunur.
Erişim belirteci (cihaz) değişirse yeni bir depo oluşturulur ve botun
şifreli odalar için yeniden doğrulanması gerekir.

**Cihaz doğrulama:**
E2EE etkinleştirildiğinde bot, başlangıçta diğer oturumlarınızdan doğrulama ister.
Element’i (veya başka bir istemciyi) açın ve güven tesis etmek için doğrulama isteğini onaylayın.
Doğrulandıktan sonra bot, şifreli odalardaki mesajları çözebilir.

## Yönlendirme modeli

- Yanıtlar her zaman Matrix’e geri gider.
- DM’ler ajanın ana oturumunu paylaşır; odalar grup oturumlarına eşlenir.

## Erişim denetimi (DM’ler)

- Varsayılan: `channels.matrix.dm.policy = "pairing"`. Bilinmeyen göndericiler bir eşleştirme kodu alır.
- Onaylama yolları:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Herkese açık DM’ler: `channels.matrix.dm.policy="open"` artı `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` tam Matrix kullanıcı kimliklerini kabul eder (örnek: `@user:server`). Sihirbaz, dizin aramasında tek ve tam eşleşme bulunduğunda görünen adları kullanıcı kimliklerine çözer.

## Odalar (gruplar)

- Varsayılan: `channels.matrix.groupPolicy = "allowlist"` (bahis/mention ile kapılı). Ayarlanmadığında varsayılanı geçersiz kılmak için `channels.defaults.groupPolicy` kullanın.
- Odaları `channels.matrix.groups` ile izin listesine alın (oda kimlikleri veya takma adlar; dizin aramasında tek ve tam eşleşme bulunduğunda adlar kimliklere çözülür):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` o odada otomatik yanıtı etkinleştirir.
- `groups."*"` odalar genelinde mention kapılama için varsayılanları ayarlayabilir.
- `groupAllowFrom` odalarda botu tetikleyebilecek göndericileri kısıtlar (tam Matrix kullanıcı kimlikleri).
- Oda başına `users` izin listeleri, belirli bir oda içinde göndericileri daha da kısıtlayabilir (tam Matrix kullanıcı kimliklerini kullanın).
- Yapılandırma sihirbazı, oda izin listelerini ister (oda kimlikleri, takma adlar veya adlar) ve adları yalnızca tam ve benzersiz eşleşmede çözer.
- Başlangıçta OpenClaw, izin listelerindeki oda/kullanıcı adlarını kimliklere çözer ve eşlemeyi günlüğe yazar; çözülemeyen girdiler izin listesi eşleştirmesinde yok sayılır.
- Davetler varsayılan olarak otomatik kabul edilir; `channels.matrix.autoJoin` ve `channels.matrix.autoJoinAllowlist` ile kontrol edin.
- **Hiç oda**ya izin vermek için `channels.matrix.groupPolicy: "disabled"` ayarlayın (veya boş bir izin listesi bırakın).
- Eski anahtar: `channels.matrix.rooms` (`groups` ile aynı yapı).

## Thread’ler

- Yanıt thread’leri desteklenir.
- `channels.matrix.threadReplies` yanıtların thread içinde kalıp kalmayacağını kontrol eder:
  - `off`, `inbound` (varsayılan), `always`
- `channels.matrix.replyToMode`, thread içinde yanıtlanmadığında reply-to meta verisini kontrol eder:
  - `off` (varsayılan), `first`, `all`

## Capabilities

| Özellik           | Status                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Doğrudan mesajlar | ✅ Desteklenir                                                                                                          |
| Odalar            | ✅ Desteklenir                                                                                                          |
| Thread’ler        | ✅ Desteklenir                                                                                                          |
| Medya             | ✅ Desteklenir                                                                                                          |
| E2EE              | ✅ Supported (crypto module required)                                                                |
| Tepkiler          | ✅ Desteklenir (araçlar üzerinden gönderme/okuma)                                                    |
| Polls             | ✅ Gönderme desteklenir; gelen anket başlatmaları metne dönüştürülür (yanıtlar/bitişler yok sayılır) |
| Konum             | ✅ Desteklenir (geo URI; irtifa yok sayılır)                                                         |
| Native commands   | ✅ Desteklenir                                                                                                          |

## Sorun Giderme

Önce şu merdiveni çalıştırın:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ardından gerekirse DM eşleştirme durumunu doğrulayın:

```bash
openclaw pairing list matrix
```

Yaygın hatalar:

- Giriş yapıldı ancak oda mesajları yok sayılıyor: oda `groupPolicy` veya oda izin listesi tarafından engellenmiş.
- DM’ler yok sayılıyor: `channels.matrix.dm.policy="pairing"` durumundayken gönderici onay bekliyor.
- Şifreli odalar başarısız: kripto desteği veya şifreleme ayarları uyumsuz.

Triyaj akışı için: [/channels/troubleshooting](/channels/troubleshooting).

## Yapılandırma başvurusu (Matrix)

Tam yapılandırma: [Yapılandırma](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.matrix.enabled`: kanal başlatmayı etkinleştir/devre dışı bırak.
- `channels.matrix.homeserver`: homeserver URL’si.
- `channels.matrix.userId`: Matrix kullanıcı kimliği (erişim belirteciyle isteğe bağlı).
- `channels.matrix.accessToken`: erişim belirteci.
- `channels.matrix.password`: giriş için parola (belirteç saklanır).
- `channels.matrix.deviceName`: cihaz görünen adı.
- `channels.matrix.encryption`: E2EE’yi etkinleştir (varsayılan: false).
- `channels.matrix.initialSyncLimit`: başlangıç senkronizasyon sınırı.
- `channels.matrix.threadReplies`: `off | inbound | always` (varsayılan: inbound).
- `channels.matrix.textChunkLimit`: giden metin parça boyutu (karakter).
- `channels.matrix.chunkMode`: `length` (varsayılan) veya uzunluk parçalamasından önce boş satırlarda (paragraf sınırları) bölmek için `newline`.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (varsayılan: eşleştirme).
- `channels.matrix.dm.allowFrom`: DM izin listesi (tam Matrix kullanıcı kimlikleri). `open` için `"*"` gerekir. Sihirbaz mümkün olduğunda adları kimliklere çözer.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (varsayılan: izin listesi).
- `channels.matrix.groupAllowFrom`: grup mesajları için izinli göndericiler (tam Matrix kullanıcı kimlikleri).
- `channels.matrix.allowlistOnly`: DM’ler + odalar için izin listesi kurallarını zorla.
- `channels.matrix.groups`: grup izin listesi + oda başına ayar eşlemesi.
- `channels.matrix.rooms`: eski grup izin listesi/yapılandırması.
- `channels.matrix.replyToMode`: thread’ler/etiketler için reply-to modu.
- `channels.matrix.mediaMaxMb`: gelen/giden medya sınırı (MB).
- `channels.matrix.autoJoin`: davet işleme (`always | allowlist | off`, varsayılan: her zaman).
- `channels.matrix.autoJoinAllowlist`: otomatik katılım için izin verilen oda kimlikleri/takma adları.
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).
