---
summary: "imsg üzerinden eski iMessage desteği (stdio üzerinde JSON-RPC). Yeni kurulumlar BlueBubbles kullanmalıdır."
read_when:
  - iMessage desteğini kurma
  - iMessage gönderme/alma hata ayıklama
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:18Z
---

# iMessage (eski: imsg)

> **Önerilen:** Yeni iMessage kurulumları için [BlueBubbles](/channels/bluebubbles) kullanın.
>
> `imsg` kanalı, eski bir harici CLI entegrasyonudur ve gelecekteki bir sürümde kaldırılabilir.

Durum: eski harici CLI entegrasyonu. Gateway, `imsg rpc`’ü (stdio üzerinde JSON-RPC) başlatır.

## Hızlı kurulum (başlangıç)

1. Bu Mac’te Messages’ın oturum açmış olduğundan emin olun.
2. `imsg`’ü yükleyin:
   - `brew install steipete/tap/imsg`
3. OpenClaw’ı `channels.imessage.cliPath` ve `channels.imessage.dbPath` ile yapılandırın.
4. Gateway’i başlatın ve macOS istemlerini (Otomasyon + Tam Disk Erişimi) onaylayın.

Asgari yapılandırma:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Nedir

- macOS’te `imsg` tarafından desteklenen iMessage kanalı.
- Deterministik yönlendirme: yanıtlar her zaman iMessage’a geri döner.
- DM’ler ajanın ana oturumunu paylaşır; gruplar yalıtılmıştır (`agent:<agentId>:imessage:group:<chat_id>`).
- `is_group=false` ile gelen çok katılımcılı bir iş parçacığı varsa, `channels.imessage.groups` kullanarak `chat_id` ile yine de yalıtabilirsiniz (aşağıdaki “Grup benzeri iş parçacıkları”na bakın).

## Yapılandırma yazımları

Varsayılan olarak iMessage, `/config set|unset` tarafından tetiklenen yapılandırma güncellemelerini yazmaya izinlidir ( `commands.config: true` gerektirir).

Devre dışı bırakmak için:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Gereksinimler

- Messages’ta oturum açılmış macOS.
- OpenClaw + `imsg` için Tam Disk Erişimi (Messages DB erişimi).
- Gönderim sırasında Otomasyon izni.
- `channels.imessage.cliPath`, stdin/stdout’u proxy’leyen herhangi bir komuta işaret edebilir (örneğin, başka bir Mac’e SSH yapan ve `imsg rpc`’yi çalıştıran bir sarmalayıcı betik).

## macOS Gizlilik ve Güvenlik TCC sorun giderme

Gönderme/alma başarısız olursa (örneğin, `imsg rpc` sıfır olmayan bir kodla çıkar, zaman aşımına uğrar veya gateway takılı kalmış gibi görünür), yaygın bir neden hiç onaylanmamış bir macOS izin istemidir.

macOS, TCC izinlerini uygulama/süreç bağlamına göre verir. İstemleri, `imsg`’yi çalıştıran bağlamda onaylayın (örneğin, Terminal/iTerm, bir LaunchAgent oturumu veya SSH ile başlatılan bir süreç).

Kontrol listesi:

- **Tam Disk Erişimi**: OpenClaw’ı çalıştıran süreç (ve `imsg`’yi çalıştıran herhangi bir kabuk/SSH sarmalayıcısı) için erişime izin verin. Bu, Messages veritabanını (`chat.db`) okumak için gereklidir.
- **Otomasyon → Messages**: Giden gönderimler için OpenClaw’ı çalıştıran sürecin (ve/veya terminalinizin) **Messages.app**’i denetlemesine izin verin.
- **`imsg` CLI sağlığı**: `imsg`’ün kurulu olduğunu ve RPC’yi (`imsg rpc --help`) desteklediğini doğrulayın.

İpucu: OpenClaw başsız (LaunchAgent/systemd/SSH) çalışıyorsa, macOS istemini kaçırmak kolaydır. İstemi zorlamak için bir GUI terminalinde tek seferlik etkileşimli bir komut çalıştırın, ardından yeniden deneyin:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

İlgili macOS klasör izinleri (Masaüstü/Belgeler/İndirilenler): [/platforms/mac/permissions](/platforms/mac/permissions).

## Kurulum (hızlı yol)

1. Bu Mac’te Messages’ın oturum açmış olduğundan emin olun.
2. iMessage’ı yapılandırın ve gateway’i başlatın.

### Özel bot macOS kullanıcısı (yalıtılmış kimlik için)

Botun **ayrı bir iMessage kimliğinden** göndermesini (ve kişisel Messages’ınızı temiz tutmayı) istiyorsanız, özel bir Apple ID + özel bir macOS kullanıcısı kullanın.

1. Özel bir Apple ID oluşturun (örnek: `my-cool-bot@icloud.com`).
   - Apple doğrulama / 2FA için bir telefon numarası isteyebilir.
2. Bir macOS kullanıcısı oluşturun (örnek: `openclawhome`) ve oturum açın.
3. Bu macOS kullanıcısında Messages’ı açın ve bot Apple ID’siyle iMessage’a giriş yapın.
4. Uzak Oturum Açma’yı etkinleştirin (Sistem Ayarları → Genel → Paylaşım → Uzak Oturum Açma).
5. `imsg`’yi yükleyin:
   - `brew install steipete/tap/imsg`
6. `ssh <bot-macos-user>@localhost true`’un parola olmadan çalışması için SSH’yi ayarlayın.
7. `channels.imessage.accounts.bot.cliPath`’ı, bot kullanıcısı olarak `imsg`’i çalıştıran bir SSH sarmalayıcısına yönlendirin.

İlk çalıştırma notu: gönderme/alma, _bot macOS kullanıcısında_ GUI onayları (Otomasyon + Tam Disk Erişimi) gerektirebilir. `imsg rpc` takılı kalmış gibi görünüyorsa veya çıkıyorsa, o kullanıcıya giriş yapın (Ekran Paylaşımı yardımcı olur), tek seferlik bir `imsg chats --limit 1` / `imsg send ...` çalıştırın, istemleri onaylayın ve ardından yeniden deneyin. [macOS Gizlilik ve Güvenlik TCC sorun giderme](#troubleshooting-macos-privacy-and-security-tcc) bölümüne bakın.

Örnek sarmalayıcı (`chmod +x`). `<bot-macos-user>`’yı gerçek macOS kullanıcı adınızla değiştirin:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Örnek yapılandırma:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Tek hesaplı kurulumlar için, `accounts` haritası yerine düz seçenekleri (`channels.imessage.cliPath`, `channels.imessage.dbPath`) kullanın.

### Uzak/SSH varyantı (isteğe bağlı)

iMessage’ı başka bir Mac’te istiyorsanız, `channels.imessage.cliPath`’yi uzak macOS ana makinesinde SSH üzerinden `imsg`’i çalıştıran bir sarmalayıcıya ayarlayın. OpenClaw yalnızca stdio’ya ihtiyaç duyar.

Örnek sarmalayıcı:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Uzak ekler:** `cliPath` SSH üzerinden uzak bir ana makineye işaret ettiğinde, Messages veritabanındaki ek yolları uzak makinedeki dosyalara referans verir. OpenClaw, `channels.imessage.remoteHost` ayarlanarak bunları SCP üzerinden otomatik olarak alabilir:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

`remoteHost` ayarlanmazsa, OpenClaw sarmalayıcı betiğinizdeki SSH komutunu ayrıştırarak otomatik algılamaya çalışır. Güvenilirlik için açık yapılandırma önerilir.

#### Tailscale üzerinden uzak Mac (örnek)

Gateway bir Linux ana makinesinde/VM’de çalışıyor ancak iMessage’ın bir Mac’te çalışması gerekiyorsa, Tailscale en basit köprüdür: Gateway, tailnet üzerinden Mac ile konuşur, SSH üzerinden `imsg`’i çalıştırır ve ekleri SCP ile geri alır.

Mimari:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Somut yapılandırma örneği (Tailscale ana makine adı):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Örnek sarmalayıcı (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Notlar:

- Mac’in Messages’ta oturum açmış olduğundan ve Uzak Oturum Açma’nın etkin olduğundan emin olun.
- `ssh bot@mac-mini.tailnet-1234.ts.net`’nin istemler olmadan çalışması için SSH anahtarlarını kullanın.
- `remoteHost`, eklerin SCP ile alınabilmesi için SSH hedefiyle eşleşmelidir.

Çoklu hesap desteği: hesap başına yapılandırma ve isteğe bağlı `name` ile `channels.imessage.accounts` kullanın. Ortak desen için [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) bölümüne bakın. `~/.openclaw/openclaw.json`’yi commit etmeyin (genellikle belirteçler içerir).

## Erişim denetimi (DM’ler + gruplar)

DM’ler:

- Varsayılan: `channels.imessage.dmPolicy = "pairing"`.
- Bilinmeyen gönderenler bir eşleştirme kodu alır; onaylanana kadar mesajlar yok sayılır (kodlar 1 saat sonra süresi dolar).
- Onaylama:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Eşleştirme, iMessage DM’leri için varsayılan belirteç değişimidir. Ayrıntılar: [Pairing](/channels/pairing)

Gruplar:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `allowlist` ayarlandığında, gruplarda kimin tetikleyebileceğini `channels.imessage.groupAllowFrom` denetler.
- Bahsetme kapısı, iMessage’da yerel bahsetme meta verisi olmadığı için `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`) kullanır.
- Çoklu ajan geçersiz kılma: `agents.list[].groupChat.mentionPatterns` üzerinde ajan başına desenler ayarlayın.

## Nasıl çalışır (davranış)

- `imsg`, mesaj olaylarını akış halinde iletir; gateway bunları paylaşılan kanal zarfına normalize eder.
- Yanıtlar her zaman aynı sohbet kimliğine veya handle’a yönlendirilir.

## Grup benzeri iş parçacıkları (`is_group=false`)

Bazı iMessage iş parçacıkları birden fazla katılımcıya sahip olabilir ancak Messages’ın sohbet tanımlayıcıyı nasıl sakladığına bağlı olarak yine de `is_group=false` ile gelebilir.

`channels.imessage.groups` altında açıkça bir `chat_id` yapılandırırsanız, OpenClaw bu iş parçacığını aşağıdakiler için “grup” olarak ele alır:

- oturum yalıtımı (ayrı `agent:<agentId>:imessage:group:<chat_id>` oturum anahtarı)
- grup izin listesi / bahsetme kapısı davranışı

Örnek:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Bu, belirli bir iş parçacığı için yalıtılmış bir kişilik/model istediğinizde kullanışlıdır (bkz. [Çoklu ajan yönlendirme](/concepts/multi-agent)). Dosya sistemi yalıtımı için [Sandboxing](/gateway/sandboxing) bölümüne bakın.

## Medya + sınırlar

- `channels.imessage.includeAttachments` ile isteğe bağlı ek alımı.
- `channels.imessage.mediaMaxMb` ile medya üst sınırı.

## Sınırlar

- Giden metin, `channels.imessage.textChunkLimit`’e kadar parçalara bölünür (varsayılan 4000).
- İsteğe bağlı satır sonu parçalama: uzunluk parçalamadan önce boş satırlarda (paragraf sınırları) bölmek için `channels.imessage.chunkMode="newline"`’i ayarlayın.
- Medya yüklemeleri `channels.imessage.mediaMaxMb` ile sınırlandırılır (varsayılan 16).

## Adresleme / teslim hedefleri

Kararlı yönlendirme için `chat_id`’ü tercih edin:

- `chat_id:123` (tercih edilen)
- `chat_guid:...`
- `chat_identifier:...`
- doğrudan handle’lar: `imessage:+1555` / `sms:+1555` / `user@example.com`

Sohbetleri listele:

```
imsg chats --limit 20
```

## Yapılandırma başvurusu (iMessage)

Tam yapılandırma: [Yapılandırma](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.imessage.enabled`: kanal başlatmayı etkinleştir/devre dışı bırak.
- `channels.imessage.cliPath`: `imsg` yolu.
- `channels.imessage.dbPath`: Messages DB yolu.
- `channels.imessage.remoteHost`: `cliPath` uzak bir Mac’i işaret ettiğinde SCP ek aktarımı için SSH ana makinesi (ör. `user@gateway-host`). Ayarlanmazsa SSH sarmalayıcıdan otomatik algılanır.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS bölgesi.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (varsayılan: eşleştirme).
- `channels.imessage.allowFrom`: DM izin listesi (handle’lar, e-postalar, E.164 numaraları veya `chat_id:*`). `open`, `"*"` gerektirir. iMessage’da kullanıcı adları yoktur; handle’ları veya sohbet hedeflerini kullanın.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (varsayılan: izin listesi).
- `channels.imessage.groupAllowFrom`: grup gönderen izin listesi.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: bağlam olarak dahil edilecek en fazla grup mesajı (0 devre dışı bırakır).
- `channels.imessage.dmHistoryLimit`: kullanıcı dönüşleri cinsinden DM geçmişi sınırı. Kullanıcı başına geçersiz kılmalar: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: grup başına varsayılanlar + izin listesi (küresel varsayılanlar için `"*"` kullanın).
- `channels.imessage.includeAttachments`: ekleri bağlama al.
- `channels.imessage.mediaMaxMb`: gelen/giden medya üst sınırı (MB).
- `channels.imessage.textChunkLimit`: giden parça boyutu (karakter).
- `channels.imessage.chunkMode`: uzunluk parçalamadan önce boş satırlarda (paragraf sınırları) bölmek için `length` (varsayılan) veya `newline`.

İlgili küresel seçenekler:

- `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
