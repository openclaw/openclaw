---
summary: "Telegram bot destek durumu, yetenekler ve yapılandırma"
read_when:
  - Telegram özellikleri veya webhook’lar üzerinde çalışırken
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:26Z
---

# Telegram (Bot API)

Durum: grammY üzerinden bot DM’leri + gruplar için production‑ready. Varsayılan olarak long‑polling; webhook isteğe bağlıdır.

## Hızlı kurulum (başlangıç)

1. **@BotFather** ile bir bot oluşturun ([doğrudan bağlantı](https://t.me/BotFather)). Kullanıcı adının tam olarak `@BotFather` olduğunu doğrulayın, ardından belirteci kopyalayın.
2. Belirteci ayarlayın:
   - Ortam değişkeni: `TELEGRAM_BOT_TOKEN=...`
   - Ya da yapılandırma: `channels.telegram.botToken: "..."`.
   - Her ikisi de ayarlıysa, yapılandırma önceliklidir (ortam değişkeni geri dönüş olarak yalnızca varsayılan hesap içindir).
3. Gateway’i başlatın.
4. DM erişimi varsayılan olarak eşleştirmedir; ilk temas sırasında eşleştirme kodunu onaylayın.

Minimal yapılandırma:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## Nedir?

- Gateway’e ait bir Telegram Bot API kanalıdır.
- Deterministik yönlendirme: yanıtlar Telegram’a geri döner; model kanal seçmez.
- DM’ler ajanın ana oturumunu paylaşır; gruplar yalıtılmıştır (`agent:<agentId>:telegram:group:<chatId>`).

## Kurulum (hızlı yol)

### 1) Bot belirteci oluşturma (BotFather)

1. Telegram’ı açın ve **@BotFather** ile sohbet edin ([doğrudan bağlantı](https://t.me/BotFather)). Kullanıcı adının tam olarak `@BotFather` olduğunu doğrulayın.
2. `/newbot` çalıştırın, ardından yönergeleri izleyin (ad + `bot` ile biten kullanıcı adı).
3. Belirteci kopyalayın ve güvenle saklayın.

İsteğe bağlı BotFather ayarları:

- `/setjoingroups` — botun gruplara eklenmesine izin ver/engelle.
- `/setprivacy` — botun tüm grup mesajlarını görüp görmeyeceğini denetle.

### 2) Belirteci yapılandırma (ortam değişkeni veya config)

Örnek:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Ortam değişkeni seçeneği: `TELEGRAM_BOT_TOKEN=...` (varsayılan hesap için çalışır).
Hem ortam değişkeni hem de yapılandırma ayarlıysa, yapılandırma önceliklidir.

Çoklu hesap desteği: hesap başına belirteçler ve isteğe bağlı `name` ile `channels.telegram.accounts` kullanın. Ortak desen için [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) bölümüne bakın.

3. Gateway’i başlatın. Bir belirteç çözümlendiğinde Telegram başlar (önce yapılandırma, ortam değişkeni geri dönüş).
4. DM erişimi varsayılan olarak eşleştirmedir. Bot ilk kez iletişime geçtiğinde kodu onaylayın.
5. Gruplar için: botu ekleyin, gizlilik/yönetici davranışını belirleyin (aşağıda), ardından mention kapısı + izin listelerini denetlemek için `channels.telegram.groups` ayarlayın.

## Belirteç + gizlilik + izinler (Telegram tarafı)

### Belirteç oluşturma (BotFather)

- `/newbot` botu oluşturur ve belirteci döndürür (gizli tutun).
- Bir belirteç sızarsa, @BotFather üzerinden iptal/yeniden oluşturun ve yapılandırmanızı güncelleyin.

### Grup mesajı görünürlüğü (Gizlilik Modu)

Telegram botları varsayılan olarak **Gizlilik Modu** ile gelir; bu mod gruplarda hangi mesajları alabileceklerini sınırlar.
Botunuzun gruptaki _tüm_ mesajları görmesi gerekiyorsa iki seçeneğiniz vardır:

- `/setprivacy` ile gizlilik modunu kapatın **veya**
- Botu grup **yöneticisi** olarak ekleyin (yönetici botlar tüm mesajları alır).

**Not:** Gizlilik modunu değiştirdiğinizde, değişikliğin geçerli olması için botu her gruptan kaldırıp yeniden eklemeniz gerekir.

### Grup izinleri (yönetici yetkileri)

Yönetici durumu grup içinde (Telegram arayüzü) ayarlanır. Yönetici botlar her zaman tüm grup mesajlarını alır; tam görünürlük gerekiyorsa yöneticiyi kullanın.

## Nasıl çalışır (davranış)

- Gelen mesajlar, yanıt bağlamı ve medya yer tutucuları ile paylaşılan kanal zarfına normalize edilir.
- Grup yanıtları varsayılan olarak bir mention gerektirir (yerel @mention veya `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Çoklu ajan geçersiz kılma: `agents.list[].groupChat.mentionPatterns` üzerinde ajan başına desenler ayarlayın.
- Yanıtlar her zaman aynı Telegram sohbetine yönlendirilir.
- Long‑polling, sohbet başına sıralama ile grammY runner kullanır; genel eşzamanlılık `agents.defaults.maxConcurrent` ile sınırlandırılır.
- Telegram Bot API okundu bilgilerini desteklemez; `sendReadReceipts` seçeneği yoktur.

## Taslak akışı

OpenClaw, Telegram DM’lerinde `sendMessageDraft` kullanarak kısmi yanıtları akış halinde gönderebilir.

Gereksinimler:

- @BotFather’da bot için Threaded Mode etkin olmalıdır (forum konu modu).
- Yalnızca özel sohbet iş parçacıkları (Telegram, gelen mesajlarda `message_thread_id` içerir).
- `channels.telegram.streamMode`, `"off"` olarak ayarlı olmamalıdır (varsayılan: `"partial"`; `"block"` parça parça taslak güncellemelerini etkinleştirir).

Taslak akışı yalnızca DM’ler içindir; Telegram gruplar veya kanallar için desteklemez.

## Biçimlendirme (Telegram HTML)

- Giden Telegram metni `parse_mode: "HTML"` kullanır (Telegram’ın desteklediği etiket alt kümesi).
- Markdown benzeri giriş **Telegram‑güvenli HTML**’e dönüştürülür (kalın/italik/üstü çizili/kod/bağlantılar); blok öğeleri yeni satırlar/maddelerle metne düzleştirilir.
- Modellerden gelen ham HTML, Telegram ayrıştırma hatalarını önlemek için kaçışlanır.
- Telegram HTML yükünü reddederse, OpenClaw aynı mesajı düz metin olarak yeniden dener.

## Komutlar (yerel + özel)

OpenClaw, başlangıçta Telegram’ın bot menüsüne yerel komutları (`/status`, `/reset`, `/model` gibi) kaydeder.
Yapılandırma ile menüye özel komutlar ekleyebilirsiniz:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## Kurulum sorun giderme (komutlar)

- Günlüklerde `setMyCommands failed` genellikle `api.telegram.org` adresine giden HTTPS/DNS çıkışının engellendiği anlamına gelir.
- `sendMessage` veya `sendChatAction` hataları görürseniz, IPv6 yönlendirmesi ve DNS’i kontrol edin.

Daha fazla yardım: [Kanal sorun giderme](/channels/troubleshooting).

Notlar:

- Özel komutlar **yalnızca menü girdileridir**; OpenClaw bunları başka yerde ele almadıkça uygulamaz.
- Komut adları normalize edilir (başta gelen `/` kaldırılır, küçük harfe çevrilir) ve `a-z`, `0-9`, `_` ile eşleşmelidir (1–32 karakter).
- Özel komutlar **yerel komutların üzerine yazamaz**. Çakışmalar yok sayılır ve kayda alınır.
- `commands.native` devre dışıysa, yalnızca özel komutlar kaydedilir (yoksa temizlenir).

## Sınırlar

- Giden metin `channels.telegram.textChunkLimit`’a bölünür (varsayılan 4000).
- İsteğe bağlı yeni satıra göre bölme: uzunluk bölmeden önce boş satırlarda (paragraf sınırları) bölmek için `channels.telegram.chunkMode="newline"` ayarlayın.
- Medya indirme/yükleme `channels.telegram.mediaMaxMb` ile sınırlandırılır (varsayılan 5).
- Telegram Bot API istekleri `channels.telegram.timeoutSeconds` sonra zaman aşımına uğrar (grammY ile varsayılan 500). Uzun beklemeleri önlemek için daha düşüğe ayarlayın.
- Grup geçmişi bağlamı `channels.telegram.historyLimit` (veya `channels.telegram.accounts.*.historyLimit`) kullanır; aksi halde `messages.groupChat.historyLimit`’ya düşer. Devre dışı bırakmak için `0` ayarlayın (varsayılan 50).
- DM geçmişi `channels.telegram.dmHistoryLimit` (kullanıcı dönüşleri) ile sınırlandırılabilir. Kullanıcı başına geçersiz kılmalar: `channels.telegram.dms["<user_id>"].historyLimit`.

## Grup etkinleştirme modları

Varsayılan olarak bot, gruplarda yalnızca mention’lara yanıt verir (`@botname` veya `agents.list[].groupChat.mentionPatterns` içindeki desenler). Bu davranışı değiştirmek için:

### Yapılandırma ile (önerilen)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**Önemli:** `channels.telegram.groups` ayarlamak bir **izin listesi** oluşturur — yalnızca listelenen gruplar (veya `"*"`) kabul edilir.
Forum konuları, `channels.telegram.groups.<groupId>.topics.<topicId>` altında konu başına geçersiz kılmalar eklemediğiniz sürece üst grup yapılandırmasını (allowFrom, requireMention, skills, prompts) devralır.

Tüm gruplara her zaman yanıt vermek için:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

Tüm gruplar için yalnızca mention (varsayılan davranış):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### Komut ile (oturum düzeyi)

Grupta gönderin:

- `/activation always` — tüm mesajlara yanıt ver
- `/activation mention` — mention gerektir (varsayılan)

**Not:** Komutlar yalnızca oturum durumunu günceller. Yeniden başlatmalar arasında kalıcı davranış için yapılandırmayı kullanın.

### Grup sohbet kimliğini alma

Gruptaki herhangi bir mesajı Telegram’da `@userinfobot` veya `@getidsbot`’e iletin; sohbet kimliğini görürsünüz (ör. `-1001234567890` gibi negatif bir sayı).

**İpucu:** Kendi kullanıcı kimliğiniz için botla DM başlatın; bot kullanıcı kimliğinizle yanıt verir (eşleştirme mesajı) veya komutlar etkinleştirildikten sonra `/whoami` kullanın.

**Gizlilik notu:** `@userinfobot` üçüncü taraf bir bottur. İsterseniz botu gruba ekleyin, bir mesaj gönderin ve `openclaw logs --follow` ile `chat.id`’ü okuyun ya da Bot API `getUpdates` kullanın.

## Yapılandırma yazımları

Varsayılan olarak Telegram, kanal olayları veya `/config set|unset` tarafından tetiklenen yapılandırma güncellemelerini yazmaya yetkilidir.

Bu şu durumlarda olur:

- Bir grup süper gruba yükseltilir ve Telegram `migrate_to_chat_id` yayar (sohbet kimliği değişir). OpenClaw, `channels.telegram.groups`’yi otomatik olarak taşıyabilir.
- Bir Telegram sohbetinde `/config set` veya `/config unset` çalıştırırsınız (`commands.config: true` gerektirir).

Devre dışı bırakmak için:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Konular (forum süper grupları)

Telegram forum konuları, mesaj başına bir `message_thread_id` içerir. OpenClaw:

- Her konunun yalıtılması için Telegram grup oturum anahtarına `:topic:<threadId>` ekler.
- Yanıtların konu içinde kalması için yazıyor göstergeleri ve yanıtları `message_thread_id` ile gönderir.
- Genel konu (iş parçacığı kimliği `1`) özeldir: mesaj gönderimleri `message_thread_id` içermez (Telegram reddeder), ancak yazıyor göstergeleri yine de içerir.
- Yönlendirme/şablonlama için şablon bağlamında `MessageThreadId` + `IsForum` sunar.
- Konuya özgü yapılandırma `channels.telegram.groups.<chatId>.topics.<threadId>` altında mevcuttur (skills, izin listeleri, otomatik yanıt, sistem istemleri, devre dışı).
- Konu yapılandırmaları, konu başına geçersiz kılınmadıkça grup ayarlarını (requireMention, izin listeleri, skills, prompts, enabled) devralır.

Özel sohbetler bazı uç durumlarda `message_thread_id` içerebilir. OpenClaw DM oturum anahtarını değiştirmez; ancak mevcutsa yanıtlar/taslak akışı için iş parçacığı kimliğini kullanır.

## Satır İçi Düğmeler

Telegram, geri çağırım düğmeleri olan satır içi klavyeleri destekler.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

Hesap başına yapılandırma için:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

Kapsamlar:

- `off` — satır içi düğmeler devre dışı
- `dm` — yalnızca DM’ler (grup hedefleri engellenir)
- `group` — yalnızca gruplar (DM hedefleri engellenir)
- `all` — DM’ler + gruplar
- `allowlist` — DM’ler + gruplar, ancak yalnızca `allowFrom`/`groupAllowFrom` tarafından izin verilen gönderenler (kontrol komutlarıyla aynı kurallar)

Varsayılan: `allowlist`.
Eski: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Düğme gönderme

Mesaj aracını `buttons` parametresiyle kullanın:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

Bir kullanıcı bir düğmeye tıkladığında, geri çağırım verisi ajana şu biçimde bir mesaj olarak gönderilir:
`callback_data: value`

### Yapılandırma seçenekleri

Telegram yetenekleri iki düzeyde yapılandırılabilir (yukarıda nesne biçimi gösterilmiştir; eski dize dizileri hâlâ desteklenir):

- `channels.telegram.capabilities`: Aksi belirtilmedikçe tüm Telegram hesaplarına uygulanan genel varsayılan yetenek yapılandırması.
- `channels.telegram.accounts.<account>.capabilities`: Belirli bir hesap için genel varsayılanları geçersiz kılan hesap başına yetenekler.

Tüm Telegram botlarının/hesaplarının aynı davranması gerektiğinde genel ayarı kullanın. Farklı botların farklı davranışlara ihtiyacı olduğunda hesap başına yapılandırmayı kullanın (ör. bir hesap yalnızca DM’leri ele alırken diğeri gruplara izinli olabilir).

## Erişim denetimi (DM’ler + gruplar)

### DM erişimi

- Varsayılan: `channels.telegram.dmPolicy = "pairing"`. Bilinmeyen gönderenler bir eşleştirme kodu alır; onaylanana kadar mesajlar yok sayılır (kodlar 1 saat sonra dolar).
- Onaylama yolları:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- Eşleştirme, Telegram DM’leri için varsayılan belirteç değişimidir. Ayrıntılar: [Eşleştirme](/channels/pairing)
- `channels.telegram.allowFrom` sayısal kullanıcı kimliklerini (önerilir) veya `@username` girdilerini kabul eder. Bot kullanıcı adı değildir; insan gönderenin kimliğini kullanın. Sihirbaz `@username` kabul eder ve mümkünse sayısal kimliğe çözer.

#### Telegram kullanıcı kimliğinizi bulma

Daha güvenli (üçüncü taraf bot yok):

1. Gateway’i başlatın ve botunuza DM gönderin.
2. `openclaw logs --follow` çalıştırın ve `from.id`’i arayın.

Alternatif (resmî Bot API):

1. Botunuza DM gönderin.
2. Bot belirtecinizle güncellemeleri çekin ve `message.from.id`’yi okuyun:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Üçüncü taraf (daha az gizli):

- `@userinfobot` veya `@getidsbot`’e DM gönderin ve dönen kullanıcı kimliğini kullanın.

### Grup erişimi

İki bağımsız denetim:

**1. Hangi gruplara izin verildiği** (`channels.telegram.groups` ile grup izin listesi):

- `groups` yapılandırması yok = tüm gruplara izin verilir
- `groups` yapılandırması varsa = yalnızca listelenen gruplar veya `"*"` izinlidir
- Örnek: `"groups": { "-1001234567890": {}, "*": {} }` tüm gruplara izin verir

**2. Hangi gönderenlere izin verildiği** (`channels.telegram.groupPolicy` ile gönderen filtreleme):

- `"open"` = izinli gruplardaki tüm gönderenler mesaj atabilir
- `"allowlist"` = yalnızca `channels.telegram.groupAllowFrom` içindeki gönderenler mesaj atabilir
- `"disabled"` = grup mesajları hiç kabul edilmez
  Varsayılan `groupPolicy: "allowlist"`’tir (`groupAllowFrom` eklemediğiniz sürece engelli).

Çoğu kullanıcı için önerilen: `groupPolicy: "allowlist"` + `groupAllowFrom` + `channels.telegram.groups` içinde belirli gruplar

Belirli bir grupta **herhangi bir grup üyesinin** konuşmasına izin vermek için (kontrol komutlarını yetkili gönderenlerle sınırlı tutarken), grup başına geçersiz kılma ayarlayın:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## Long‑polling vs webhook

- Varsayılan: long‑polling (herhangi bir herkese açık URL gerekmez).
- Webhook modu: `channels.telegram.webhookUrl` ve `channels.telegram.webhookSecret` ayarlayın (isteğe bağlı `channels.telegram.webhookPath`).
  - Yerel dinleyici `0.0.0.0:8787`’e bağlanır ve varsayılan olarak `POST /telegram-webhook`’ü sunar.
  - Genel URL’niz farklıysa, bir ters vekil kullanın ve `channels.telegram.webhookUrl`’i genel uç noktaya yönlendirin.

## Yanıt iş parçacıkları

Telegram, etiketler aracılığıyla isteğe bağlı iş parçacıklı yanıtları destekler:

- `[[reply_to_current]]` — tetikleyici mesaja yanıt ver.
- `[[reply_to:<id>]]` — belirli bir mesaj kimliğine yanıt ver.

`channels.telegram.replyToMode` ile denetlenir:

- `first` (varsayılan), `all`, `off`.

## Sesli mesajlar (ses notu vs dosya)

Telegram **ses notları**nı (yuvarlak balon) **ses dosyaları**ndan (meta veri kartı) ayırır.
OpenClaw, geriye dönük uyumluluk için varsayılan olarak ses dosyalarını kullanır.

Ajan yanıtlarında ses notu balonu zorlamak için, yanıtta herhangi bir yere şu etiketi ekleyin:

- `[[audio_as_voice]]` — sesi dosya yerine ses notu olarak gönder.

Etiket iletilen metinden çıkarılır. Diğer kanallar bu etiketi yok sayar.

Mesaj aracıyla gönderimler için, ses uyumlu bir `media` URL’si ile `asVoice: true` ayarlayın
(medya mevcutken `message` isteğe bağlıdır):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Çıkartmalar

OpenClaw, akıllı önbellekleme ile Telegram çıkartmalarını alma ve gönderme destekler.

### Çıkartma alma

Bir kullanıcı çıkartma gönderdiğinde, OpenClaw çıkartma türüne göre işlem yapar:

- **Statik çıkartmalar (WEBP):** İndirilir ve görsel işleme üzerinden işlenir. Çıkartma, mesaj içeriğinde bir `<media:sticker>` yer tutucusu olarak görünür.
- **Animasyonlu çıkartmalar (TGS):** Atlanır (Lottie biçimi işleme için desteklenmez).
- **Video çıkartmalar (WEBM):** Atlanır (video biçimi işleme için desteklenmez).

Çıkartmalar alındığında kullanılabilen şablon bağlam alanı:

- `Sticker` — şu alanlara sahip nesne:
  - `emoji` — çıkartmayla ilişkili emoji
  - `setName` — çıkartma setinin adı
  - `fileId` — Telegram dosya kimliği (aynı çıkartmayı geri göndermek için)
  - `fileUniqueId` — önbellek araması için kararlı kimlik
  - `cachedDescription` — mevcutsa önbelleğe alınmış görsel açıklaması

### Çıkartma önbelleği

Çıkartmalar, açıklamalar üretmek için yapay zekânın görsel yeteneklerinden geçirilir. Aynı çıkartmalar sık gönderildiğinden, OpenClaw yinelenen API çağrılarını önlemek için bu açıklamaları önbellekler.

**Nasıl çalışır:**

1. **İlk karşılaşma:** Çıkartma görseli görsel analiz için yapay zekâya gönderilir. Yapay zekâ bir açıklama üretir (örn. “Heyecanla el sallayan bir çizgi film kedisi”).
2. **Önbelleğe alma:** Açıklama; çıkartmanın dosya kimliği, emojisi ve set adıyla birlikte kaydedilir.
3. **Sonraki karşılaşmalar:** Aynı çıkartma tekrar görüldüğünde, önbellekteki açıklama doğrudan kullanılır. Görsel yapay zekâya gönderilmez.

**Önbellek konumu:** `~/.openclaw/telegram/sticker-cache.json`

**Önbellek kayıt biçimi:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**Faydalar:**

- Aynı çıkartma için tekrarlanan görsel çağrıları önleyerek API maliyetlerini düşürür
- Önbelleğe alınmış çıkartmalar için daha hızlı yanıt süreleri (görsel işleme gecikmesi yok)
- Önbelleğe alınmış açıklamalara dayalı çıkartma arama işlevini mümkün kılar

Önbellek, çıkartmalar alındıkça otomatik olarak doldurulur. Elle önbellek yönetimi gerekmez.

### Çıkartma gönderme

Ajan, `sticker` ve `sticker-search` eylemlerini kullanarak çıkartma gönderebilir ve arayabilir. Bunlar varsayılan olarak devre dışıdır ve yapılandırmada etkinleştirilmelidir:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**Bir çıkartma gönderin:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Parametreler:

- `fileId` (zorunlu) — çıkartmanın Telegram dosya kimliği. Bunu, bir çıkartma alırken `Sticker.fileId`’den veya bir `sticker-search` sonucundan edinin.
- `replyTo` (isteğe bağlı) — yanıtlanacak mesaj kimliği.
- `threadId` (isteğe bağlı) — forum konuları için mesaj iş parçacığı kimliği.

**Çıkartma arama:**

Ajan, açıklama, emoji veya set adına göre önbelleğe alınmış çıkartmaları arayabilir:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Önbellekten eşleşen çıkartmaları döndürür:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

Arama; açıklama metni, emoji karakterleri ve set adları üzerinde bulanık eşleştirme kullanır.

**İş parçacığı ile örnek:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## Akış (taslaklar)

Telegram, ajan yanıt üretirken **taslak baloncukları** akış halinde gösterebilir.
OpenClaw, Bot API `sendMessageDraft`’i (gerçek mesajlar değildir) kullanır ve ardından
nihai yanıtı normal bir mesaj olarak gönderir.

Gereksinimler (Telegram Bot API 9.3+):

- **Konular etkin olan özel sohbetler** (bot için forum konu modu).
- Gelen mesajlar `message_thread_id` içermelidir (özel konu iş parçacığı).
- Gruplar/süper gruplar/kanallar için akış yok sayılır.

Yapılandırma:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (varsayılan: `partial`)
  - `partial`: taslak baloncuğunu en son akış metniyle güncelle.
  - `block`: taslak baloncuğunu daha büyük bloklar halinde güncelle (parçalı).
  - `off`: taslak akışını devre dışı bırak.
- İsteğe bağlı (yalnızca `streamMode: "block"` için):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - varsayılanlar: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (`channels.telegram.textChunkLimit`’e sıkıştırılır).

Not: taslak akışı, **blok halinde akış**tan (kanal mesajları) ayrıdır.
Blok halinde akış varsayılan olarak kapalıdır ve taslak güncellemeleri yerine erken Telegram mesajları istiyorsanız `channels.telegram.blockStreaming: true` gerektirir.

Gerekçelendirme akışı (yalnızca Telegram):

- `/reasoning stream`, yanıt üretilirken gerekçelendirmeyi taslak baloncuğuna akış halinde gönderir, ardından gerekçelendirme olmadan nihai yanıtı yollar.
- `channels.telegram.streamMode` `off` ise gerekçelendirme akışı devre dışıdır.
  Daha fazla bağlam: [Akış + parçalama](/concepts/streaming).

## Yeniden deneme ilkesi

Giden Telegram API çağrıları, geçici ağ/429 hatalarında üstel geri çekilme ve jitter ile yeniden denenir. `channels.telegram.retry` üzerinden yapılandırın. [Yeniden deneme ilkesi](/concepts/retry) bölümüne bakın.

## Ajan aracı (mesajlar + tepkiler)

- Araç: `telegram` ve `sendMessage` eylemi (`to`, `content`, isteğe bağlı `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Araç: `telegram` ve `react` eylemi (`chatId`, `messageId`, `emoji`).
- Araç: `telegram` ve `deleteMessage` eylemi (`chatId`, `messageId`).
- Tepki kaldırma semantiği: [/tools/reactions](/tools/reactions).
- Araç kapılama: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (varsayılan: etkin) ve `channels.telegram.actions.sticker` (varsayılan: devre dışı).

## Tepki bildirimleri

**Tepkiler nasıl çalışır:**
Telegram tepkileri, mesaj yüklerinde özellik olarak değil, **ayrı `message_reaction` olayları** olarak gelir. Bir kullanıcı tepki eklediğinde OpenClaw:

1. Telegram API’den `message_reaction` güncellemesini alır
2. Bunu şu biçimde bir **sistem olayı**na dönüştürür: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Sistem olayını normal mesajlarla **aynı oturum anahtarı** ile kuyruğa alır
4. Aynı konuşmada bir sonraki mesaj geldiğinde, sistem olayları boşaltılır ve ajanın bağlamının başına eklenir

Ajan, tepkileri konuşma geçmişinde mesaj meta verisi olarak değil, **sistem bildirimleri** olarak görür.

**Yapılandırma:**

- `channels.telegram.reactionNotifications`: Hangi tepkilerin bildirim tetikleyeceğini denetler
  - `"off"` — tüm tepkileri yok say
  - `"own"` — kullanıcılar bot mesajlarına tepki verdiğinde bildir (en iyi çaba; bellek içi) (varsayılan)
  - `"all"` — tüm tepkiler için bildir

- `channels.telegram.reactionLevel`: Ajanın tepki yeteneğini denetler
  - `"off"` — ajan mesajlara tepki veremez
  - `"ack"` — bot onaylayıcı tepkiler gönderir (işlenirken 👀) (varsayılan)
  - `"minimal"` — ajan ölçülü şekilde tepki verebilir (kılavuz: 5–10 etkileşimde 1)
  - `"extensive"` — ajan uygun olduğunda serbestçe tepki verebilir

**Forum grupları:** Forum gruplarındaki tepkiler `message_thread_id` içerir ve `agent:main:telegram:group:{chatId}:topic:{threadId}` gibi oturum anahtarları kullanır. Bu, aynı konudaki tepkiler ve mesajların birlikte kalmasını sağlar.

**Örnek yapılandırma:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**Gereksinimler:**

- Telegram botları, `allowed_updates` içinde açıkça `message_reaction` talep etmelidir (OpenClaw tarafından otomatik yapılandırılır)
- Webhook modunda tepkiler webhook `allowed_updates` içinde yer alır
- Polling modunda tepkiler `getUpdates` `allowed_updates` içinde yer alır

## Teslim hedefleri (CLI/cron)

- Hedef olarak bir sohbet kimliği (`123456789`) veya bir kullanıcı adı (`@name`) kullanın.
- Örnek: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Sorun giderme

**Bot grupta mention olmayan mesajlara yanıt vermiyor:**

- `channels.telegram.groups.*.requireMention=false` ayarladıysanız, Telegram Bot API **gizlilik modu** devre dışı olmalıdır.
  - BotFather: `/setprivacy` → **Disable** (sonra botu gruptan kaldırıp yeniden ekleyin)
- `openclaw channels status`, yapılandırma mention’sız grup mesajlarını beklediğinde uyarı gösterir.
- `openclaw channels status --probe`, açık sayısal grup kimlikleri için üyeliği ayrıca denetleyebilir (joker `"*"` kurallarını denetleyemez).
- Hızlı test: `/activation always` (yalnızca oturum; kalıcılık için yapılandırmayı kullanın)

**Bot grup mesajlarını hiç görmüyor:**

- `channels.telegram.groups` ayarlıysa, grup listelenmiş olmalı veya `"*"` kullanılmalıdır
- @BotFather’da Gizlilik Ayarlarını kontrol edin → “Group Privacy” **OFF** olmalı
- Botun gerçekten üye olduğunu doğrulayın (okuma erişimi olmayan yalnızca yönetici değil)
- Gateway günlüklerini kontrol edin: `openclaw logs --follow` (“skipping group message” arayın)

**Bot mention’lara yanıt veriyor ama `/activation always`’e vermiyor:**

- `/activation` komutu oturum durumunu günceller ancak yapılandırmaya kalıcı yazmaz
- Kalıcı davranış için grubu `channels.telegram.groups`’ye `requireMention: false` ile ekleyin

**`/status` gibi komutlar çalışmıyor:**

- Telegram kullanıcı kimliğinizin yetkili olduğundan emin olun (eşleştirme veya `channels.telegram.allowFrom` ile)
- Komutlar, `groupPolicy: "open"` olan gruplarda bile yetkilendirme gerektirir

**Node 22+ üzerinde long‑polling hemen iptal oluyor (çoğunlukla proxy/özel fetch ile):**

- Node 22+, `AbortSignal` örnekleri konusunda daha katıdır; yabancı sinyaller `fetch` çağrılarını anında iptal edebilir.
- İptal sinyallerini normalize eden bir OpenClaw sürümüne yükseltin veya yükseltene kadar Gateway’i Node 20 üzerinde çalıştırın.

**Bot başlıyor, sonra sessizce yanıt vermeyi bırakıyor (veya `HttpError: Network request ... failed` kaydı düşüyor):**

- Bazı barındırmalar `api.telegram.org`’yi önce IPv6’ya çözer. Sunucunuzda çalışan IPv6 çıkışı yoksa, grammY IPv6‑yalnız isteklerde takılabilir.
- Çözüm: IPv6 çıkışını etkinleştirin **veya** `api.telegram.org` için IPv4 çözümlemesini zorlayın (ör. IPv4 A kaydını kullanarak bir `/etc/hosts` girdisi ekleyin ya da işletim sisteminizin DNS yığınında IPv4’ü tercih edin), ardından Gateway’i yeniden başlatın.
- Hızlı kontrol: DNS’in ne döndürdüğünü doğrulamak için `dig +short api.telegram.org A` ve `dig +short api.telegram.org AAAA`.

## Yapılandırma başvurusu (Telegram)

Tam yapılandırma: [Yapılandırma](/gateway/configuration)

Sağlayıcı seçenekleri:

- `channels.telegram.enabled`: kanal başlangıcını etkinleştir/devre dışı bırak.
- `channels.telegram.botToken`: bot belirteci (BotFather).
- `channels.telegram.tokenFile`: belirteci dosya yolundan oku.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (varsayılan: eşleştirme).
- `channels.telegram.allowFrom`: DM izin listesi (kimlikler/kullanıcı adları). `open`, `"*"` gerektirir.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (varsayılan: izin listesi).
- `channels.telegram.groupAllowFrom`: grup gönderen izin listesi (kimlikler/kullanıcı adları).
- `channels.telegram.groups`: grup başına varsayılanlar + izin listesi (genel varsayılanlar için `"*"` kullanın).
  - `channels.telegram.groups.<id>.groupPolicy`: groupPolicy için grup başına geçersiz kılma (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: mention kapısı varsayılanı.
  - `channels.telegram.groups.<id>.skills`: skill filtresi (yok = tüm Skills, boş = hiçbiri).
  - `channels.telegram.groups.<id>.allowFrom`: grup başına gönderen izin listesi geçersiz kılması.
  - `channels.telegram.groups.<id>.systemPrompt`: grup için ek sistem istemi.
  - `channels.telegram.groups.<id>.enabled`: `false` olduğunda grubu devre dışı bırak.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: konu başına geçersiz kılmalar (grup ile aynı alanlar).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: groupPolicy için konu başına geçersiz kılma (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: konu başına mention kapısı geçersiz kılması.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (varsayılan: izin listesi).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: hesap başına geçersiz kılma.
- `channels.telegram.replyToMode`: `off | first | all` (varsayılan: `first`).
- `channels.telegram.textChunkLimit`: giden parça boyutu (karakter).
- `channels.telegram.chunkMode`: `length` (varsayılan) veya uzunluk bölmeden önce boş satırlarda (paragraf sınırları) bölmek için `newline`.
- `channels.telegram.linkPreview`: giden mesajlar için bağlantı önizlemelerini aç/kapat (varsayılan: true).
- `channels.telegram.streamMode`: `off | partial | block` (taslak akışı).
- `channels.telegram.mediaMaxMb`: gelen/giden medya üst sınırı (MB).
- `channels.telegram.retry`: giden Telegram API çağrıları için yeniden deneme ilkesi (denemeler, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: Node autoSelectFamily geçersiz kılması (true=etkin, false=devre dışı). Node 22’de Happy Eyeballs zaman aşımını önlemek için varsayılan olarak devre dışıdır.
- `channels.telegram.proxy`: Bot API çağrıları için proxy URL’si (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: webhook modunu etkinleştirir (`channels.telegram.webhookSecret` gerektirir).
- `channels.telegram.webhookSecret`: webhook gizlisi (webhookUrl ayarlıysa zorunlu).
- `channels.telegram.webhookPath`: yerel webhook yolu (varsayılan `/telegram-webhook`).
- `channels.telegram.actions.reactions`: Telegram araç tepkilerini kapıla.
- `channels.telegram.actions.sendMessage`: Telegram araç mesaj gönderimlerini kapıla.
- `channels.telegram.actions.deleteMessage`: Telegram araç mesaj silmelerini kapıla.
- `channels.telegram.actions.sticker`: Telegram çıkartma eylemlerini kapıla — gönderme ve arama (varsayılan: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — hangi tepkilerin sistem olaylarını tetikleyeceğini denetler (ayarlı değilse varsayılan: `own`).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — ajanın tepki yeteneğini denetler (ayarlı değilse varsayılan: `minimal`).

İlgili genel seçenekler:

- `agents.list[].groupChat.mentionPatterns` (mention kapısı desenleri).
- `messages.groupChat.mentionPatterns` (genel geri dönüş).
- `commands.native` (varsayılan `"auto"` → Telegram/Discord için açık, Slack için kapalı), `commands.text`, `commands.useAccessGroups` (komut davranışı). `channels.telegram.commands.native` ile geçersiz kılın.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
