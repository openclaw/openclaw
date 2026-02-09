---
summary: "Discord botu destek durumu, yetenekleri ve yapılandırması"
read_when:
  - Discord kanal özellikleri üzerinde çalışırken
title: "Discord"
---

# Discord (Bot API)

Durum: Resmî Discord bot gateway üzerinden DM ve sunucu (guild) metin kanalları için hazır.

## Hızlı kurulum (başlangıç seviyesi)

1. Bir Discord botu oluşturun ve bot belirtecini kopyalayın.
2. Discord uygulama ayarlarında **Message Content Intent**’i (ve izin listeleri veya ad aramaları kullanacaksanız **Server Members Intent**’i) etkinleştirin.
3. OpenClaw için belirteci ayarlayın:
   - Ortam değişkeni: `DISCORD_BOT_TOKEN=...`
   - Veya yapılandırma: `channels.discord.token: "..."`.
   - İkisi de ayarlanmışsa, yapılandırma önceliklidir (ortam değişkeni geri dönüş olarak yalnızca varsayılan hesap için kullanılır).
4. Botu, mesaj izinleriyle sunucunuza davet edin (yalnızca DM’ler istiyorsanız özel bir sunucu oluşturun).
5. Gateway’i başlatın.
6. DM erişimi varsayılan olarak eşleştirme gerektirir; ilk temas sırasında eşleştirme kodunu onaylayın.

Asgari yapılandırma:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Hedefler

- OpenClaw ile Discord DM’leri veya sunucu kanalları üzerinden konuşmak.
- Doğrudan sohbetler ajanın ana oturumunda birleşir (varsayılan `agent:main:main`); sunucu kanalları `agent:<agentId>:discord:channel:<channelId>` olarak yalıtılmış kalır (görünen adlar `discord:<guildSlug>#<channelSlug>` kullanır).
- Grup DM’leri varsayılan olarak yok sayılır; `channels.discord.dm.groupEnabled` ile etkinleştirin ve isteğe bağlı olarak `channels.discord.dm.groupChannels` ile kısıtlayın.
- Yönlendirmeyi deterministik tutun: yanıtlar her zaman geldikleri kanala geri gider.

## Nasıl çalışır

1. Bir Discord uygulaması → Bot oluşturun, ihtiyaç duyduğunuz intent’leri etkinleştirin (DM’ler + sunucu mesajları + mesaj içeriği) ve bot belirtecini alın.
2. Botu, kullanmak istediğiniz yerlerde mesaj okuma/gönderme izinleriyle sunucunuza davet edin.
3. OpenClaw’ı `channels.discord.token` ile (veya geri dönüş olarak `DISCORD_BOT_TOKEN`) yapılandırın.
4. Gateway’i çalıştırın; bir belirteç mevcut olduğunda (önce yapılandırma, ortam değişkeni geri dönüş) ve `channels.discord.enabled` `false` olmadığında Discord kanalı otomatik başlar.
   - Ortam değişkenlerini tercih ediyorsanız `DISCORD_BOT_TOKEN`’yi ayarlayın (yapılandırma bloğu isteğe bağlıdır).
5. Doğrudan sohbetler: teslim sırasında `user:<id>` (veya bir `<@id>` mention) kullanın; tüm turlar paylaşılan `main` oturumuna düşer. Salt sayısal kimlikler belirsizdir ve reddedilir.
6. Sunucu kanalları: teslim için `channel:<channelId>` kullanın. Mention’lar varsayılan olarak zorunludur ve sunucuya veya kanala göre ayarlanabilir.
7. Doğrudan sohbetler: varsayılan olarak `channels.discord.dm.policy` ile güvenlidir (varsayılan: `"pairing"`). Bilinmeyen gönderenler bir eşleştirme kodu alır (1 saat sonra sona erer); `openclaw pairing approve discord <code>` ile onaylayın.
   - Eski “herkese açık” davranışı sürdürmek için: `channels.discord.dm.policy="open"` ve `channels.discord.dm.allowFrom=["*"]` ayarlayın.
   - Katı izin listesi için: `channels.discord.dm.policy="allowlist"` ayarlayın ve gönderenleri `channels.discord.dm.allowFrom` içinde listeleyin.
   - Tüm DM’leri yok saymak için: `channels.discord.dm.enabled=false` veya `channels.discord.dm.policy="disabled"` ayarlayın.
8. Grup DM’leri varsayılan olarak yok sayılır; `channels.discord.dm.groupEnabled` ile etkinleştirin ve isteğe bağlı olarak `channels.discord.dm.groupChannels` ile kısıtlayın.
9. İsteğe bağlı sunucu kuralları: sunucu kimliğine (tercih edilen) veya slug’a göre anahtarlanmış `channels.discord.guilds` ayarlayın; kanal başına kurallar tanımlanabilir.
10. İsteğe bağlı yerel komutlar: `commands.native` varsayılanı `"auto"`’tir (Discord/Telegram için açık, Slack için kapalı). `channels.discord.commands.native: true|false|"auto"` ile geçersiz kılın; `false` daha önce kaydedilmiş komutları temizler. Metin komutları `commands.text` ile kontrol edilir ve bağımsız `/...` mesajları olarak gönderilmelidir. Komutlar için erişim grubu kontrollerini atlamak üzere `commands.useAccessGroups: false` kullanın.
    - Tam komut listesi + yapılandırma: [Slash commands](/tools/slash-commands)
11. İsteğe bağlı sunucu bağlam geçmişi: mention’a yanıt verirken son N sunucu mesajını bağlam olarak eklemek için `channels.discord.historyLimit` (varsayılan 20, `messages.groupChat.historyLimit`’ye geri döner) ayarlayın. Devre dışı bırakmak için `0` ayarlayın.
12. Tepkiler: ajan, `discord` aracıyla tepkileri tetikleyebilir (`channels.discord.actions.*` ile kapılıdır).
    - Tepki kaldırma semantiği: [/tools/reactions](/tools/reactions).
    - `discord` aracı yalnızca geçerli kanal Discord olduğunda açığa çıkar.
13. Yerel komutlar, paylaşılan `main` oturumu yerine yalıtılmış oturum anahtarları (`agent:<agentId>:discord:slash:<userId>`) kullanır.

Not: Ad → kimlik çözümlemesi sunucu üye aramasını kullanır ve Server Members Intent gerektirir; bot üyeleri arayamıyorsa kimlikleri veya `<@id>` mention’larını kullanın.
Not: Slug’lar küçük harflidir ve boşluklar `-` ile değiştirilir. Kanal adları baştaki `#` olmadan slug’lanır.
Not: Sunucu bağlamı `[from:]` satırları, ping’e hazır yanıtları kolaylaştırmak için `author.tag` + `id` içerir.

## Yapılandırma yazımları

Varsayılan olarak, Discord `/config set|unset` tarafından tetiklenen yapılandırma güncellemelerini yazabilir (`commands.config: true` gerektirir).

Şununla devre dışı bırakın:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Kendi botunuzu nasıl oluşturursunuz

Bu, OpenClaw’ı `#help` gibi bir sunucu (guild) kanalında çalıştırmak için “Discord Developer Portal” kurulumudur.

### 1. Discord uygulaması + bot kullanıcısı oluşturma

1. Discord Developer Portal → **Applications** → **New Application**
2. Uygulamanızda:
   - **Bot** → **Add Bot**
   - **Bot Token**’ı kopyalayın (bunu `DISCORD_BOT_TOKEN` içine koyarsınız)

### 2) OpenClaw’ın ihtiyaç duyduğu gateway intent’lerini etkinleştirme

Discord, “ayrıcalıklı intent”leri açıkça etkinleştirmedikçe engeller.

**Bot** → **Privileged Gateway Intents** altında şunları etkinleştirin:

- **Message Content Intent** (çoğu sunucuda mesaj metnini okumak için gereklidir; olmadan “Used disallowed intents” görürsünüz veya bot bağlanır ama mesajlara tepki vermez)
- **Server Members Intent** (önerilir; bazı üye/kullanıcı aramaları ve sunucularda izin listesi eşleştirmesi için gereklidir)

Genellikle **Presence Intent** gerekmez. Botun kendi varlığını ayarlamak (`setPresence` eylemi) gateway OP3 kullanır ve bu intent’i gerektirmez; yalnızca diğer sunucu üyelerinin varlık güncellemelerini almak istiyorsanız gereklidir.

### 3. Davet URL’si oluşturma (OAuth2 URL Generator)

Uygulamanızda: **OAuth2** → **URL Generator**

**Kapsamlar (Scopes)**

- ✅ `bot`
- ✅ `applications.commands` (yerel komutlar için gereklidir)

**Bot İzinleri** (asgari temel)

- ✅ Kanalları Görüntüle
- ✅ Mesaj Gönder
- ✅ Mesaj Geçmişini Oku
- ✅ Bağlantıları Göm
- ✅ Dosya Ekle
- ✅ Tepki Ekle (isteğe bağlı ama önerilir)
- ✅ Harici Emojiler / Çıkartmalar (isteğe bağlı; yalnızca istiyorsanız)

Hata ayıklamadıkça ve bota tamamen güvenmedikçe **Administrator**’dan kaçının.

Oluşturulan URL’yi kopyalayın, açın, sunucunuzu seçin ve botu kurun.

### 4. Kimlikleri alma (sunucu/kullanıcı/kanal)

Discord her yerde sayısal kimlikler kullanır; OpenClaw yapılandırması kimlikleri tercih eder.

1. Discord (masaüstü/web) → **User Settings** → **Advanced** → **Developer Mode**’u etkinleştirin
2. Sağ tıklayın:
   - Sunucu adı → **Copy Server ID** (sunucu kimliği)
   - Kanal (ör. `#help`) → **Copy Channel ID**
   - Kullanıcınız → **Copy User ID**

### 5) OpenClaw’ı yapılandırma

#### Token

Bot belirtecini ortam değişkeniyle ayarlayın (sunucularda önerilir):

- `DISCORD_BOT_TOKEN=...`

Veya yapılandırma ile:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Çoklu hesap desteği: hesap başına belirteçler ve isteğe bağlı `name` ile `channels.discord.accounts` kullanın. Paylaşılan desen için [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) bölümüne bakın.

#### İzin listesi + kanal yönlendirme

Örnek “tek sunucu, yalnızca ben, yalnızca #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Notlar:

- `requireMention: true` botun yalnızca mention edildiğinde yanıt vermesi anlamına gelir (paylaşılan kanallar için önerilir).
- `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`) sunucu mesajları için de mention olarak sayılır.
- Çoklu ajan geçersiz kılması: ajan başına desenleri `agents.list[].groupChat.mentionPatterns` üzerinde ayarlayın.
- `channels` mevcutsa, listelenmeyen herhangi bir kanal varsayılan olarak reddedilir.
- Tüm kanallara varsayılanları uygulamak için bir `"*"` kanal girdisi kullanın; açık kanal girdileri jokeri geçersiz kılar.
- Konular (threads) üst kanal yapılandırmasını (izin listesi, `requireMention`, skills, prompt’lar vb.) miras alır; thread kanal kimliğini açıkça eklemediğiniz sürece.
- Sahip ipucu: Sunucuya veya kanala özel bir `users` izin listesi göndericiyle eşleştiğinde, OpenClaw bu göndericiyi sistem prompt’unda sahip olarak ele alır. Kanallar genelinde küresel bir sahip için `commands.ownerAllowFrom` ayarlayın.
- Bot tarafından yazılan mesajlar varsayılan olarak yok sayılır; izin vermek için `channels.discord.allowBots=true` ayarlayın (kendi mesajları yine filtrelenir).
- Uyarı: Diğer botlara yanıt vermeye izin verirseniz (`channels.discord.allowBots=true`), botlar arası yanıt döngülerini `requireMention`, `channels.discord.guilds.*.channels.<id>.users` izin listeleri ve/veya `AGENTS.md` ve `SOUL.md` içindeki korumaları temizleyerek önleyin.

### 6. Çalıştığını doğrulama

1. Gateway’i başlatın.
2. Sunucu kanalınızda şunu gönderin: `@Krill hello` (veya bot adınız her neyse).
3. Hiçbir şey olmazsa: aşağıdaki **Sorun Giderme** bölümünü kontrol edin.

### Sorun Giderme

- Önce: `openclaw doctor` ve `openclaw channels status --probe` çalıştırın (eyleme geçirilebilir uyarılar + hızlı denetimler).
- **“Used disallowed intents”**: Developer Portal’da **Message Content Intent**’i (ve büyük olasılıkla **Server Members Intent**’i) etkinleştirin, ardından gateway’i yeniden başlatın.
- **Bot bağlanıyor ama sunucu kanalında asla yanıt vermiyor**:
  - **Message Content Intent** eksik, veya
  - Botun kanal izinleri yok (Görüntüle/Gönder/Geçmişi Oku), veya
  - Yapılandırmanız mention gerektiriyor ve mention etmediniz, veya
  - Your guild/channel allowlist denies the channel/user.
- **`requireMention: false` ama hâlâ yanıt yok**:
- `channels.discord.groupPolicy` varsayılanı **allowlist**’tir; `"open"` olarak ayarlayın veya `channels.discord.guilds` altında bir sunucu girdisi ekleyin (isteğe bağlı olarak `channels.discord.guilds.<id>.channels` altında kanalları listeleyerek kısıtlayın).
  - Yalnızca `DISCORD_BOT_TOKEN` ayarlayıp hiç `channels.discord` bölümü oluşturmazsanız, çalışma zamanı
    `groupPolicy`’yi `open` olarak varsayar. Kilitlemek için `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` veya bir sunucu/kanal izin listesi ekleyin.
- `requireMention` mutlaka `channels.discord.guilds` altında (veya belirli bir kanal altında) olmalıdır. En üst düzeydeki `channels.discord.requireMention` yok sayılır.
- **İzin denetimleri** (`channels status --probe`) yalnızca sayısal kanal kimliklerini kontrol eder. Slug/adları `channels.discord.guilds.*.channels` anahtarları olarak kullanırsanız denetim izinleri doğrulayamaz.
- **DM’ler çalışmıyor**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"` veya henüz onaylanmamışsınız (`channels.discord.dm.policy="pairing"`).
- **Discord’da çalıştırma onayları**: Discord, DM’lerde çalıştırma onayları için **buton UI** destekler (Bir kez izin ver / Her zaman izin ver / Reddet). `/approve <id> ...` yalnızca iletilmiş onaylar içindir ve Discord’un buton istemlerini çözmez. `❌ Failed to submit approval: Error: unknown approval id` görüyorsanız veya UI hiç görünmüyorsa, şunları kontrol edin:
  - Yapılandırmanızdaki `channels.discord.execApprovals.enabled: true`.
  - Discord kullanıcı kimliğiniz `channels.discord.execApprovals.approvers` içinde listelenmiş mi (UI yalnızca onaylayıcılara gönderilir).
  - DM istemindeki butonları kullanın (**Bir kez izin ver**, **Her zaman izin ver**, **Reddet**).
  - Daha geniş onay ve komut akışı için [Exec approvals](/tools/exec-approvals) ve [Slash commands](/tools/slash-commands) bölümlerine bakın.

## Yetenekler ve sınırlar

- DM’ler ve sunucu metin kanalları (thread’ler ayrı kanallar olarak ele alınır; ses desteklenmez).
- Yazıyor göstergeleri en iyi çabayla gönderilir; mesaj parçalama `channels.discord.textChunkLimit` (varsayılan 2000) kullanır ve uzun yanıtları satır sayısına göre böler (`channels.discord.maxLinesPerMessage`, varsayılan 17).
- İsteğe bağlı yeni satır parçalama: uzunluk parçalamadan önce boş satırlarda (paragraf sınırları) bölmek için `channels.discord.chunkMode="newline"` ayarlayın.
- Dosya yüklemeleri, yapılandırılmış `channels.discord.mediaMaxMb`’e kadar desteklenir (varsayılan 8 MB).
- Gürültülü botları önlemek için sunucu yanıtları varsayılan olarak mention ile kapılıdır.
- Bir mesaj başka bir mesaja referans verdiğinde yanıt bağlamı enjekte edilir (alıntılanan içerik + kimlikler).
- Yerel yanıt iş parçacığı varsayılan olarak **kapalıdır**; `channels.discord.replyToMode` ve yanıt etiketleriyle etkinleştirin.

## Yeniden deneme politikası

Giden Discord API çağrıları, mümkün olduğunda Discord `retry_after` kullanarak oran sınırlarında (429) yeniden dener; üstel geri çekilme ve jitter uygular. `channels.discord.retry` ile yapılandırın. [Retry policy](/concepts/retry) bölümüne bakın.

## Yapılandırma

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Onay (ack) tepkileri küresel olarak `messages.ackReaction` +
`messages.ackReactionScope` ile kontrol edilir. Bot yanıtladıktan sonra
onay tepkisini temizlemek için `messages.removeAckAfterReply` kullanın.

- `dm.enabled`: tüm DM’leri yok saymak için `false` ayarlayın (varsayılan `true`).
- `dm.policy`: DM erişim denetimi (`pairing` önerilir). `"open"` için `dm.allowFrom=["*"]` gerekir.
- `dm.allowFrom`: DM izin listesi (kullanıcı kimlikleri veya adlar). `dm.policy="allowlist"` tarafından kullanılır ve `dm.policy="open"` doğrulaması içindir. Sihirbaz, bot üyeleri arayabildiğinde kullanıcı adlarını kabul eder ve kimliklere çözer.
- `dm.groupEnabled`: grup DM’lerini etkinleştir (varsayılan `false`).
- `dm.groupChannels`: grup DM kanal kimlikleri veya slug’ları için isteğe bağlı izin listesi.
- `groupPolicy`: sunucu kanalı işleyişini kontrol eder (`open|disabled|allowlist`); `allowlist` kanal izin listeleri gerektirir.
- `guilds`: sunucu kimliğine (tercih edilen) veya slug’a göre anahtarlanmış sunucu başına kurallar.
- `guilds."*"`: açık bir giriş olmadığında uygulanan varsayılan sunucu başına ayarlar.
- `guilds.<id>.slug`: görüntülenen adlar için isteğe bağlı dostça slug.
- `guilds.<id>.users`: isteğe bağlı sunucu başına kullanıcı izin listesi (kimlikler veya adlar).
- `guilds.<id>.tools`: kanal geçersiz kılması eksik olduğunda kullanılan isteğe bağlı sunucu başına araç politikası geçersiz kılmaları (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.toolsBySender`: kanal geçersiz kılması eksik olduğunda uygulanan sunucu düzeyinde gönderici başına araç politikası geçersiz kılmaları (`"*"` jokeri desteklenir).
- `guilds.<id>.channels.<channel>.allow`: `groupPolicy="allowlist"` olduğunda kanalı izin ver/reddet.
- `guilds.<id>.channels.<channel>.requireMention`: kanal için mention kapısı.
- `guilds.<id>.channels.<channel>.tools`: isteğe bağlı kanal başına araç politikası geçersiz kılmaları (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: kanal içinde gönderici başına isteğe bağlı araç politikası geçersiz kılmaları (`"*"` jokeri desteklenir).
- `guilds.<id>.channels.<channel>.users`: isteğe bağlı kanal başına kullanıcı izin listesi.
- `guilds.<id>.channels.<channel>.skills`: skill filtresi (boş = tüm skills, empty = hiçbiri).
- `guilds.<id>.channels.<channel>.systemPrompt`: kanal için ek sistem prompt’u. Discord kanal konuları **güvenilmeyen** bağlam olarak enjekte edilir (sistem prompt’u değildir).
- `guilds.<id>.channels.<channel>.enabled`: kanalı devre dışı bırakmak için `false` ayarlayın.
- `guilds.<id>.channels`: kanal kuralları (anahtarlar kanal slug’ları veya kimlikleridir).
- `guilds.<id>.requireMention`: sunucu başına mention gereksinimi (kanal başına geçersiz kılınabilir).
- `guilds.<id>.reactionNotifications`: tepki sistemi olay modu (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: giden metin parça boyutu (karakter). Varsayılan: 2000.
- `chunkMode`: `length` (varsayılan) yalnızca `textChunkLimit` aşıldığında böler; `newline` uzunluk parçalamadan önce boş satırlarda (paragraf sınırları) böler.
- `maxLinesPerMessage`: mesaj başına yumuşak maksimum satır sayısı. Varsayılan: 17.
- `mediaMaxMb`: diske kaydedilen gelen medyayı sınırla.
- `historyLimit`: mention’a yanıt verirken bağlam olarak eklenecek son sunucu mesajı sayısı (varsayılan 20; `messages.groupChat.historyLimit`’e geri döner; `0` devre dışı bırakır).
- `dmHistoryLimit`: kullanıcı dönüşleri cinsinden DM geçmiş sınırı. Kullanıcı başına geçersiz kılmalar: `dms["<user_id>"].historyLimit`.
- `retry`: giden Discord API çağrıları için yeniden deneme politikası (deneme sayısı, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: PluralKit proxy’li mesajları çözerek sistem üyelerinin ayrı göndericiler olarak görünmesini sağlar.
- `actions`: eylem başına araç kapıları; atlanırsa tümüne izin verilir (devre dışı bırakmak için `false` ayarlayın).
  - `reactions` (tepki verme + tepkileri okuma kapsar)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (kanal + kategori + izin oluştur/düzenle/sil)
  - `roles` (rol ekle/çıkar, varsayılan `false`)
  - `moderation` (zaman aşımı/atma/yasaklama, varsayılan `false`)
  - `presence` (bot durumu/etkinliği, varsayılan `false`)
- `execApprovals`: Discord’a özgü çalıştırma onayı DM’leri (buton UI). `enabled`, `approvers`, `agentFilter`, `sessionFilter` destekler.

Tepki bildirimleri `guilds.<id>.reactionNotifications` kullanır:

- `off`: tepki olayı yok.
- `own`: botun kendi mesajlarındaki tepkiler (varsayılan).
- `all`: tüm mesajlardaki tüm tepkiler.
- `allowlist`: `guilds.<id>.users`’ten gelen tepkiler tüm mesajlarda (boş liste devre dışı bırakır).

### PluralKit (PK) desteği

Proxy’li mesajların altta yatan sistem + üyeye çözülmesi için PK aramalarını etkinleştirin.
Etkinleştirildiğinde OpenClaw, izin listeleri için üye kimliğini kullanır ve
kazara Discord ping’lerini önlemek için göndericiyi `Member (PK:System)` olarak etiketler.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

İzin listesi notları (PK etkin):

- `dm.allowFrom`, `guilds.<id>.users` veya kanal başına `users` içinde `pk:<memberId>` kullanın.
- Üye görünen adları ad/slug ile de eşleştirilir.
- Aramalar **orijinal** Discord mesaj kimliğini (proxy öncesi mesaj) kullanır; bu nedenle
  PK API’si yalnızca 30 dakikalık penceresi içinde çözer.
- PK aramaları başarısız olursa (ör. belirteci olmayan özel sistem), proxy’li mesajlar
  bot mesajları olarak değerlendirilir ve `channels.discord.allowBots=true` yoksa düşürülür.

### Tool action defaults

| Eylem grubu    | Varsayılan | Notlar                                                |
| -------------- | ---------- | ----------------------------------------------------- |
| reactions      | enabled    | Tepki ver + tepkileri listele + emojiList             |
| stickers       | enabled    | Send stickers                                         |
| emojiUploads   | enabled    | Emoji yükle                                           |
| stickerUploads | enabled    | Upload stickers                                       |
| polls          | enabled    | Anket oluştur                                         |
| permissions    | enabled    | Kanal izin anlık görüntüsü                            |
| messages       | enabled    | Oku/gönder/düzenle/sil                                |
| threads        | enabled    | Oluştur/listele/yanıtla                               |
| pins           | enabled    | Sabitle/kaldır/listele                                |
| search         | enabled    | Mesaj arama (önizleme özelliği)    |
| memberInfo     | enabled    | Üye bilgisi                                           |
| roleInfo       | enabled    | Rol listesi                                           |
| channelInfo    | enabled    | Kanal bilgisi + liste                                 |
| channels       | enabled    | Kanal/kategori yönetimi                               |
| voiceStatus    | enabled    | Voice state lookup                                    |
| events         | enabled    | Zamanlanmış etkinlikleri listele/oluştur              |
| roles          | disabled   | Rol ekle/çıkar                                        |
| moderation     | disabled   | Zaman aşımı/atma/yasaklama                            |
| presence       | disabled   | Bot durumu/etkinliği (setPresence) |

- `replyToMode`: `off` (varsayılan), `first` veya `all`. Yalnızca model bir yanıt etiketi içerdiğinde uygulanır.

## Yanıt etiketleri

İş parçacıklı bir yanıt istemek için model çıktısına bir etiket ekleyebilir:

- `[[reply_to_current]]` — tetikleyen Discord mesajına yanıt ver.
- `[[reply_to:<id>]]` — bağlam/geçmişten belirli bir mesaj kimliğine yanıt ver.
  Mevcut mesaj kimlikleri prompt’lara `[message_id: …]` olarak eklenir; geçmiş girdileri zaten kimlik içerir.

Davranış `channels.discord.replyToMode` ile kontrol edilir:

- `off`: etiketleri yok say.
- `first`: yalnızca ilk giden parça/ek bir yanıttır.
- `all`: her giden parça/ek bir yanıttır.

İzin listesi eşleştirme notları:

- `allowFrom`/`users`/`groupChannels` kimlikleri, adları, etiketleri veya `<@id>` gibi mention’ları kabul eder.
- `discord:`/`user:` (kullanıcılar) ve `channel:` (grup DM’leri) gibi önekler desteklenir.
- Herhangi bir gönderici/kanala izin vermek için `*` kullanın.
- `guilds.<id>.channels` mevcutsa, listelenmeyen kanallar varsayılan olarak reddedilir.
- `guilds.<id>.channels` atlanırsa, izin listesine alınmış sunucudaki tüm kanallara izin verilir.
- **Hiç kanal**a izin vermemek için `channels.discord.groupPolicy: "disabled"` ayarlayın (veya boş bir izin listesi bırakın).
- Yapılandırma sihirbazı `Guild/Channel` adlarını (genel + özel) kabul eder ve mümkün olduğunda kimliklere çözer.
- Başlangıçta OpenClaw, izin listelerindeki kanal/kullanıcı adlarını kimliklere çözer (bot üyeleri arayabildiğinde)
  ve eşlemeyi günlüğe yazar; çözülemeyen girdiler yazıldığı gibi tutulur.

Yerel komut notları:

- Kayıtlı komutlar OpenClaw’ın sohbet komutlarını yansıtır.
- Yerel komutlar, DM’ler/sunucu mesajları ile aynı izin listelerini uygular (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, kanal başına kurallar).
- Slash komutları, izin listesinde olmayan kullanıcılara Discord UI’da yine de görünebilir; OpenClaw yürütmede izin listelerini uygular ve “yetkili değil” yanıtını verir.

## Araç eylemleri

Ajan, aşağıdaki gibi eylemlerle `discord` çağırabilir:

- `react` / `reactions` (tepki ekle veya listele)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Okuma/arama/sabitleme araç yükleri, normalize edilmiş `timestampMs` (UTC epoch ms) ve `timestampUtc`’yı ham Discord `timestamp` ile birlikte içerir.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (bot etkinliği ve çevrimiçi durumu)

Discord mesaj kimlikleri, ajanın hedefleyebilmesi için enjekte edilen bağlamda (`[discord message id: …]` ve geçmiş satırları) görünür.
Emoji’ler unicode (ör. `✅`) veya `<:party_blob:1234567890>` gibi özel emoji sözdizimi olabilir.

## Güvenli kullanım & operasyonlar

- Bot belirtecini parola gibi ele alın; denetimli ana makinelerde `DISCORD_BOT_TOKEN` ortam değişkenini tercih edin veya yapılandırma dosyası izinlerini kilitleyin.
- Bota yalnızca ihtiyaç duyduğu izinleri verin (genellikle Mesajları Oku/Gönder).
- Bot takılı kalırsa veya oran sınırlamasına girerse, Discord oturumuna başka süreçlerin sahip olmadığını doğruladıktan sonra gateway’i yeniden başlatın (`openclaw gateway --force`).
