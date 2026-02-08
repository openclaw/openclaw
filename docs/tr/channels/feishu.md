---
summary: "Feishu botuna genel bakış, özellikler ve yapılandırma"
read_when:
  - Bir Feishu/Lark botu bağlamak istiyorsunuz
  - Feishu kanalını yapılandırıyorsunuz
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:10Z
---

# Feishu botu

Feishu (Lark), şirketler tarafından mesajlaşma ve iş birliği için kullanılan bir ekip sohbet platformudur. Bu eklenti, OpenClaw’u platformun WebSocket olay aboneliğini kullanarak bir Feishu/Lark botuna bağlar; böylece herkese açık bir webhook URL’si açmadan mesajlar alınabilir.

---

## Gerekli eklenti

Feishu eklentisini yükleyin:

```bash
openclaw plugins install @openclaw/feishu
```

Yerel checkout (bir git deposundan çalıştırırken):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Hızlı Başlangıç

Feishu kanalını eklemenin iki yolu vardır:

### Yöntem 1: onboarding sihirbazı (önerilen)

OpenClaw’u yeni kurduysanız sihirbazı çalıştırın:

```bash
openclaw onboard
```

Sihirbaz sizi şu adımlarda yönlendirir:

1. Bir Feishu uygulaması oluşturma ve kimlik bilgilerini toplama
2. Uygulama kimlik bilgilerini OpenClaw’da yapılandırma
3. Gateway’i başlatma

✅ **Yapılandırmadan sonra**, gateway durumunu kontrol edin:

- `openclaw gateway status`
- `openclaw logs --follow`

### Yöntem 2: CLI ile kurulum

İlk kurulumu zaten tamamladıysanız, kanalı CLI üzerinden ekleyin:

```bash
openclaw channels add
```

**Feishu**’yu seçin, ardından App ID ve App Secret’ı girin.

✅ **Yapılandırmadan sonra**, gateway’i yönetin:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Adım 1: Bir Feishu uygulaması oluşturun

### 1. Feishu Open Platform’u açın

[Feishu Open Platform](https://open.feishu.cn/app) adresini ziyaret edin ve oturum açın.

Lark (küresel) kiracıları [https://open.larksuite.com/app](https://open.larksuite.com/app) adresini kullanmalı ve Feishu yapılandırmasında `domain: "lark"` ayarını yapmalıdır.

### 2. Bir uygulama oluşturun

1. **Create enterprise app**’e tıklayın
2. Uygulama adı ve açıklamasını doldurun
3. Bir uygulama simgesi seçin

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Kimlik bilgilerini kopyalayın

**Credentials & Basic Info** bölümünden şunları kopyalayın:

- **App ID** (format: `cli_xxx`)
- **App Secret**

❗ **Önemli:** App Secret’ı gizli tutun.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. İzinleri yapılandırın

**Permissions** bölümünde **Batch import**’a tıklayın ve şunu yapıştırın:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Bot yeteneğini etkinleştirin

**App Capability** > **Bot** bölümünde:

1. Bot yeteneğini etkinleştirin
2. Bot adını ayarlayın

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Olay aboneliğini yapılandırın

⚠️ **Önemli:** olay aboneliğini ayarlamadan önce şunlardan emin olun:

1. Feishu için `openclaw channels add` komutunu zaten çalıştırdınız
2. Gateway çalışıyor (`openclaw gateway status`)

**Event Subscription** bölümünde:

1. **Use long connection to receive events** (WebSocket) seçeneğini seçin
2. Şu olayı ekleyin: `im.message.receive_v1`

⚠️ Gateway çalışmıyorsa, uzun bağlantı ayarları kaydedilemeyebilir.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Uygulamayı yayınlayın

1. **Version Management & Release** bölümünde bir sürüm oluşturun
2. İncelemeye gönderin ve yayınlayın
3. Yönetici onayını bekleyin (kurumsal uygulamalar genellikle otomatik onaylanır)

---

## Adım 2: OpenClaw’u yapılandırın

### Sihirbaz ile yapılandırma (önerilen)

```bash
openclaw channels add
```

**Feishu**’yu seçin ve App ID ile App Secret’ı yapıştırın.

### Yapılandırma dosyası ile yapılandırma

`~/.openclaw/openclaw.json` dosyasını düzenleyin:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Ortam değişkenleri ile yapılandırma

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (küresel) alan adı

Kiracınız Lark (uluslararası) üzerindeyse alan adını `lark` (veya tam bir alan adı dizesi) olarak ayarlayın. Bunu `channels.feishu.domain` konumunda ya da hesap bazında (`channels.feishu.accounts.<id>.domain`) ayarlayabilirsiniz.

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Adım 3: Başlatma + test

### 1. Gateway’i başlatın

```bash
openclaw gateway
```

### 2. Test mesajı gönderin

Feishu’da botunuzu bulun ve bir mesaj gönderin.

### 3. Eşleştirmeyi onaylayın

Varsayılan olarak bot bir eşleştirme kodu ile yanıt verir. Onaylayın:

```bash
openclaw pairing approve feishu <CODE>
```

Onaydan sonra normal şekilde sohbet edebilirsiniz.

---

## Genel bakış

- **Feishu bot kanalı**: Gateway tarafından yönetilen Feishu botu
- **Deterministik yönlendirme**: yanıtlar her zaman Feishu’ya döner
- **Oturum yalıtımı**: DM’ler ana bir oturumu paylaşır; gruplar yalıtılmıştır
- **WebSocket bağlantısı**: Feishu SDK üzerinden uzun bağlantı, herkese açık URL gerekmez

---

## Erişim denetimi

### Doğrudan mesajlar

- **Varsayılan**: `dmPolicy: "pairing"` (bilinmeyen kullanıcılar eşleştirme kodu alır)
- **Eşleştirmeyi onayla**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **İzin listesi modu**: izin verilen Open ID’lerle `channels.feishu.allowFrom` ayarlayın

### Grup sohbetleri

**1. Grup politikası** (`channels.feishu.groupPolicy`):

- `"open"` = gruplarda herkese izin ver (varsayılan)
- `"allowlist"` = yalnızca `groupAllowFrom`’e izin ver
- `"disabled"` = grup mesajlarını devre dışı bırak

**2. Bahsetme gereksinimi** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @bahsetme zorunlu (varsayılan)
- `false` = bahsetme olmadan yanıtla

---

## Grup yapılandırma örnekleri

### Tüm gruplara izin ver, @bahsetme zorunlu (varsayılan)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Tüm gruplara izin ver, @bahsetme gerekmez

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Yalnızca gruplarda belirli kullanıcılara izin ver

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Grup/kullanıcı ID’lerini alma

### Grup ID’leri (chat_id)

Grup ID’leri `oc_xxx` biçimindedir.

**Yöntem 1 (önerilen)**

1. Gateway’i başlatın ve grupta botu @bahsedin
2. `openclaw logs --follow` komutunu çalıştırın ve `chat_id` değerini bulun

**Yöntem 2**

Feishu API hata ayıklayıcısını kullanarak grup sohbetlerini listeleyin.

### Kullanıcı ID’leri (open_id)

Kullanıcı ID’leri `ou_xxx` biçimindedir.

**Yöntem 1 (önerilen)**

1. Gateway’i başlatın ve bota DM gönderin
2. `openclaw logs --follow` komutunu çalıştırın ve `open_id` değerini bulun

**Yöntem 2**

Eşleştirme isteklerinden kullanıcı Open ID’lerini kontrol edin:

```bash
openclaw pairing list feishu
```

---

## Yaygın komutlar

| Komut     | Açıklama               |
| --------- | ---------------------- |
| `/status` | Bot durumunu göster    |
| `/reset`  | Oturumu sıfırla        |
| `/model`  | Modeli göster/değiştir |

> Not: Feishu henüz yerel komut menülerini desteklemediğinden, komutlar metin olarak gönderilmelidir.

## Gateway yönetim komutları

| Komut                      | Açıklama                         |
| -------------------------- | -------------------------------- |
| `openclaw gateway status`  | Gateway durumunu göster          |
| `openclaw gateway install` | Gateway servisini yükle/başlat   |
| `openclaw gateway stop`    | Gateway servisini durdur         |
| `openclaw gateway restart` | Gateway servisini yeniden başlat |
| `openclaw logs --follow`   | Gateway günlüklerini izle        |

---

## Sorun Giderme

### Bot grup sohbetlerinde yanıt vermiyor

1. Botun gruba eklendiğinden emin olun
2. Botu @bahsettiğinizden emin olun (varsayılan davranış)
3. `groupPolicy`’nin `"disabled"` olarak ayarlanmadığını kontrol edin
4. Günlükleri kontrol edin: `openclaw logs --follow`

### Bot mesaj almıyor

1. Uygulamanın yayınlandığından ve onaylandığından emin olun
2. Olay aboneliğinin `im.message.receive_v1` içerdiğinden emin olun
3. **Uzun bağlantı**nın etkin olduğundan emin olun
4. Uygulama izinlerinin eksiksiz olduğundan emin olun
5. Gateway’in çalıştığından emin olun: `openclaw gateway status`
6. Günlükleri kontrol edin: `openclaw logs --follow`

### App Secret sızıntısı

1. Feishu Open Platform’da App Secret’ı sıfırlayın
2. Yapılandırmanızdaki App Secret’ı güncelleyin
3. Gateway’i yeniden başlatın

### Mesaj gönderme hataları

1. Uygulamanın `im:message:send_as_bot` iznine sahip olduğundan emin olun
2. Uygulamanın yayınlandığından emin olun
3. Ayrıntılı hatalar için günlükleri kontrol edin

---

## Gelişmiş yapılandırma

### Birden fazla hesap

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Mesaj limitleri

- `textChunkLimit`: giden metin parça boyutu (varsayılan: 2000 karakter)
- `mediaMaxMb`: medya yükleme/indirme limiti (varsayılan: 30MB)

### Akış (Streaming)

Feishu, etkileşimli kartlar üzerinden akış yanıtlarını destekler. Etkinleştirildiğinde bot, metin üretirken bir kartı günceller.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Tam yanıt gönderilmeden önce beklemek için `streaming: false` ayarını yapın.

### Çoklu ajan yönlendirme

Feishu DM’lerini veya gruplarını farklı ajanlara yönlendirmek için `bindings` kullanın.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Yönlendirme alanları:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` veya `"group"`
- `match.peer.id`: kullanıcı Open ID’si (`ou_xxx`) veya grup ID’si (`oc_xxx`)

Arama ipuçları için [Grup/kullanıcı ID’lerini alma](#get-groupuser-ids) bölümüne bakın.

---

## Yapılandırma başvurusu

Tüm yapılandırma: [Gateway yapılandırması](/gateway/configuration)

Temel seçenekler:

| Ayar                                              | Açıklama                                | Varsayılan |
| ------------------------------------------------- | --------------------------------------- | ---------- |
| `channels.feishu.enabled`                         | Kanalı etkinleştir/devre dışı bırak     | `true`     |
| `channels.feishu.domain`                          | API alan adı (`feishu` veya `lark`)     | `feishu`   |
| `channels.feishu.accounts.<id>.appId`             | App ID                                  | -          |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                              | -          |
| `channels.feishu.accounts.<id>.domain`            | Hesap bazlı API alan adı geçersiz kılma | `feishu`   |
| `channels.feishu.dmPolicy`                        | DM politikası                           | `pairing`  |
| `channels.feishu.allowFrom`                       | DM izin listesi (open_id listesi)       | -          |
| `channels.feishu.groupPolicy`                     | Grup politikası                         | `open`     |
| `channels.feishu.groupAllowFrom`                  | Grup izin listesi                       | -          |
| `channels.feishu.groups.<chat_id>.requireMention` | @bahsetme zorunlu                       | `true`     |
| `channels.feishu.groups.<chat_id>.enabled`        | Grubu etkinleştir                       | `true`     |
| `channels.feishu.textChunkLimit`                  | Mesaj parça boyutu                      | `2000`     |
| `channels.feishu.mediaMaxMb`                      | Medya boyut limiti                      | `30`       |
| `channels.feishu.streaming`                       | Akış kartı çıktısını etkinleştir        | `true`     |
| `channels.feishu.blockStreaming`                  | Blok halinde akışı etkinleştir          | `true`     |

---

## dmPolicy başvurusu

| Değer         | Davranış                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| `"pairing"`   | **Varsayılan.** Bilinmeyen kullanıcılar eşleştirme kodu alır; onaylanmalıdır |
| `"allowlist"` | Yalnızca `allowFrom` içindeki kullanıcılar sohbet edebilir                   |
| `"open"`      | Tüm kullanıcılara izin ver (allowFrom içinde `"*"` gerektirir)               |
| `"disabled"`  | DM’leri devre dışı bırak                                                     |

---

## Desteklenen mesaj türleri

### Alma

- ✅ Metin
- ✅ Zengin metin (post)
- ✅ Görseller
- ✅ Dosyalar
- ✅ Ses
- ✅ Video
- ✅ Çıkartmalar

### Gönderme

- ✅ Metin
- ✅ Görseller
- ✅ Dosyalar
- ✅ Ses
- ⚠️ Zengin metin (kısmi destek)
