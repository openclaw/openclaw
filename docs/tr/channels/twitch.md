---
summary: "Twitch sohbet botu yapılandırması ve kurulumu"
read_when:
  - OpenClaw için Twitch sohbet entegrasyonunu kurarken
title: "Twitch"
---

# Twitch (eklenti)

IRC bağlantısı üzerinden Twitch sohbet desteği. OpenClaw, kanallarda mesaj almak ve göndermek için bir Twitch kullanıcısı (bot hesabı) olarak bağlanır.

## Gerekli eklenti

Twitch bir eklenti olarak dağıtılır ve çekirdek kurulumla birlikte gelmez.

CLI ile yükleyin (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/twitch
```

Ayrıntılar: [Plugins](/tools/plugin)

## Hızlı kurulum (başlangıç)

1. Bot için özel bir Twitch hesabı oluşturun (veya mevcut bir hesabı kullanın).
2. Kimlik bilgilerini oluşturun: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** seçin
   - `chat:read` ve `chat:write` kapsamlarının seçili olduğunu doğrulayın
   - **Client ID** ve **Access Token** değerlerini kopyalayın
3. Twitch kullanıcı kimliğinizi bulun: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Belirteci yapılandırın:
   - Ortam değişkeni: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (yalnızca varsayılan hesap)
   - Veya yapılandırma: `channels.twitch.accessToken`
   - İkisi de ayarlıysa, yapılandırma önceliklidir (ortam değişkeni geri dönüş olarak yalnızca varsayılan hesap içindir).
5. Gateway’i başlatın.

**⚠️ Önemli:** Yetkisiz kullanıcıların botu tetiklemesini önlemek için erişim denetimi (`allowFrom` veya `allowedRoles`) ekleyin. `requireMention` varsayılan olarak `true`’tür.

Asgari yapılandırma:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Nedir

- Gateway’e ait bir Twitch kanalı.
- Deterministik yönlendirme: yanıtlar her zaman Twitch’e geri gider.
- Her hesap, yalıtılmış bir oturum anahtarına eşlenir `agent:<agentId>:twitch:<accountName>`.
- `username` botun hesabıdır (kimlik doğrulayan), `channel` ise katılınacak sohbet odasıdır.

## Kurulum (ayrıntılı)

### Kimlik bilgilerini oluşturma

[Twitch Token Generator](https://twitchtokengenerator.com/) kullanın:

- **Bot Token** seçin
- `chat:read` ve `chat:write` kapsamlarının seçili olduğunu doğrulayın
- **Client ID** ve **Access Token** değerlerini kopyalayın

Manuel uygulama kaydı gerekmez. Belirteçler birkaç saat sonra sona erer.

### Botu yapılandırma

**Ortam değişkeni (yalnızca varsayılan hesap):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Veya yapılandırma:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Hem ortam değişkeni hem de yapılandırma ayarlıysa, yapılandırma önceliklidir.

### Erişim denetimi (önerilir)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Sıkı bir izin listesi için `allowFrom` tercih edin. Rol tabanlı erişim istiyorsanız bunun yerine `allowedRoles` kullanın.

**Kullanılabilir roller:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Neden kullanıcı kimlikleri?** Kullanıcı adları değişebilir ve kimliğe bürünmeye izin verebilir. Kullanıcı kimlikleri kalıcıdır.

Twitch kullanıcı kimliğinizi bulun: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Twitch kullanıcı adınızı kimliğe dönüştürün)

## Belirteç yenileme (isteğe bağlı)

[Twitch Token Generator](https://twitchtokengenerator.com/) tarafından üretilen belirteçler otomatik olarak yenilenemez — süresi dolduğunda yeniden oluşturun.

Otomatik belirteç yenileme için [Twitch Developer Console](https://dev.twitch.tv/console) üzerinde kendi Twitch uygulamanızı oluşturun ve yapılandırmaya ekleyin:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Bot, sona ermeden önce belirteçleri otomatik olarak yeniler ve yenileme olaylarını günlükler.

## Çoklu hesap desteği

Hesap başına belirteçlerle `channels.twitch.accounts` kullanın. Paylaşılan desen için [`gateway/configuration`](/gateway/configuration) sayfasına bakın.

Örnek (iki kanalda tek bot hesabı):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Not:** Her hesabın kendi belirteci gerekir (kanal başına bir belirteç).

## Erişim denetimi

### Rol tabanlı kısıtlamalar

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Kullanıcı kimliğine göre izin listesi (en güvenlisi)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Rol tabanlı erişim (alternatif)

`allowFrom` sıkı bir izin listesidir. Ayarlandığında yalnızca bu kullanıcı kimliklerine izin verilir.
Rol tabanlı erişim istiyorsanız `allowFrom` ayarsız bırakın ve bunun yerine `allowedRoles` yapılandırın:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @mention gereksinimini devre dışı bırakma

Varsayılan olarak `requireMention` değeri `true`’dir. Devre dışı bırakmak ve tüm mesajlara yanıt vermek için:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Sorun Giderme

Önce tanılama komutlarını çalıştırın:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot mesajlara yanıt vermiyor

**Erişim denetimini kontrol edin:** Kullanıcı kimliğinizin `allowFrom` içinde olduğundan emin olun veya geçici olarak
`allowFrom`’ü kaldırın ve test etmek için `allowedRoles: ["all"]` ayarlayın.

**Botun kanalda olduğundan emin olun:** Bot, `channel` içinde belirtilen kanala katılmalıdır.

### Belirteç sorunları

**"Failed to connect" veya kimlik doğrulama hataları:**

- `accessToken`’nin OAuth erişim belirteci değeri olduğunu doğrulayın (genellikle `oauth:` önekiyle başlar)
- Belirtecin `chat:read` ve `chat:write` kapsamlarına sahip olduğunu kontrol edin
- Belirteç yenileme kullanıyorsanız `clientSecret` ve `refreshToken`’nin ayarlı olduğunu doğrulayın

### Token refresh not working

**Yenileme olayları için günlükleri kontrol edin:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

"token refresh disabled (no refresh token)" görürseniz:

- `clientSecret`’ün sağlandığından emin olun
- `refreshToken`’ün sağlandığından emin olun

## Yapılandırma

**Hesap yapılandırması:**

- `username` - Bot kullanıcı adı
- `accessToken` - `chat:read` ve `chat:write` kapsamlarına sahip OAuth erişim belirteci
- `clientId` - Twitch Client ID (Token Generator’dan veya kendi uygulamanızdan)
- `channel` - Katılınacak kanal (gerekli)
- `enabled` - Bu hesabı etkinleştir (varsayılan: `true`)
- `clientSecret` - İsteğe bağlı: Otomatik belirteç yenileme için
- `refreshToken` - İsteğe bağlı: Otomatik belirteç yenileme için
- `expiresIn` - Saniye cinsinden belirteç süresi
- `obtainmentTimestamp` - Belirtecin alındığı zaman damgası
- `allowFrom` - Kullanıcı kimliği izin listesi
- `allowedRoles` - Rol tabanlı erişim denetimi (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @mention gerektir (varsayılan: `true`)

**Sağlayıcı seçenekleri:**

- `channels.twitch.enabled` - Kanal başlatmayı etkinleştir/devre dışı bırak
- `channels.twitch.username` - Bot kullanıcı adı (basitleştirilmiş tek hesap yapılandırması)
- `channels.twitch.accessToken` - OAuth erişim belirteci (basitleştirilmiş tek hesap yapılandırması)
- `channels.twitch.clientId` - Twitch Client ID (basitleştirilmiş tek hesap yapılandırması)
- `channels.twitch.channel` - Katılınacak kanal (basitleştirilmiş tek hesap yapılandırması)
- `channels.twitch.accounts.<accountName>` - Çoklu hesap yapılandırması (yukarıdaki tüm hesap alanları)

Tam örnek:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Araç eylemleri

Ajan, şu eylemle `twitch` çağrısı yapabilir:

- `send` - Bir kanala mesaj gönder

Örnek:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Güvenli kullanım ve operasyonlar

- **Belirteçleri parolalar gibi ele alın** - Belirteçleri asla git’e commit etmeyin
- **Uzun süre çalışan botlar için otomatik belirteç yenilemeyi kullanın**
- **Erişim denetimi için kullanıcı adı yerine kullanıcı kimliği izin listeleri kullanın**
- **Belirteç yenileme olayları ve bağlantı durumu için günlükleri izleyin**
- **Belirteç kapsamlarını asgari tutun** - Yalnızca `chat:read` ve `chat:write` isteyin
- **Takılırsanız**: Oturumun başka bir süreç tarafından sahiplenilmediğini doğruladıktan sonra Gateway’i yeniden başlatın

## Sınırlar

- Mesaj başına **500 karakter** (kelime sınırlarında otomatik parçalama)
- Markdown, parçalamadan önce kaldırılır
- Hız sınırlaması yoktur (Twitch’in yerleşik hız sınırları kullanılır)
