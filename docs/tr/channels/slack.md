---
summary: "Socket veya HTTP webhook modu için Slack kurulumu"
read_when: "Slack kurulurken veya Slack socket/HTTP modu hata ayıklanırken"
title: "Slack"
---

# Slack

## Socket modu (varsayılan)

### Hızlı kurulum (başlangıç)

1. Bir Slack uygulaması oluşturun ve **Socket Mode**’u etkinleştirin.
2. Bir **App Token** (`xapp-...`) ve **Bot Token** (`xoxb-...`) oluşturun.
3. OpenClaw için belirteçleri ayarlayın ve gateway’i başlatın.

Minimal yapılandırma:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Kurulum

1. [https://api.slack.com/apps](https://api.slack.com/apps) adresinde bir Slack uygulaması oluşturun (From scratch).
2. **Socket Mode** → açın. Ardından **Basic Information** → **App-Level Tokens** → `connections:write` kapsamı ile **Generate Token and Scopes**. **App Token**’ı (`xapp-...`) kopyalayın.
3. **OAuth & Permissions** → bot token kapsamlarını ekleyin (aşağıdaki manifesti kullanın). **Install to Workspace**’e tıklayın. **Bot User OAuth Token**’ı (`xoxb-...`) kopyalayın.
4. İsteğe bağlı: **OAuth & Permissions** → **User Token Scopes** ekleyin (aşağıdaki salt-okunur listeye bakın). Uygulamayı yeniden yükleyin ve **User OAuth Token**’ı (`xoxp-...`) kopyalayın.
5. **Event Subscriptions** → etkinleştirin ve şunlara abone olun:
   - `message.*` (düzenlemeler/silmeler/thread yayınlarını içerir)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Botu okumak istediğiniz kanallara davet edin.
7. Slash Commands → `channels.slack.slashCommand` kullanıyorsanız `/openclaw` oluşturun. Yerel komutları etkinleştirirseniz, her yerleşik komut için bir slash command ekleyin (`/help` ile aynı adlar). Yerel komutlar, `channels.slack.commands.native: true` ayarlanmadıkça Slack için varsayılan olarak kapalıdır (genel `commands.native` varsayılanı `"auto"` olup Slack’i kapalı bırakır).
8. App Home → kullanıcıların botla DM yapabilmesi için **Messages Tab**’i etkinleştirin.

Kapsamlar ve olaylar senkronize kalsın diye aşağıdaki manifesti kullanın.

Çoklu hesap desteği: hesap başına belirteçlerle `channels.slack.accounts` kullanın ve isteğe bağlı `name`. Ortak desen için [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) bölümüne bakın.

### OpenClaw yapılandırması (Socket modu)

Set tokens via env vars (recommended):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Veya yapılandırma ile:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Kullanıcı belirteci (isteğe bağlı)

OpenClaw, okuma işlemleri (geçmiş,
pinler, tepkiler, emoji, üye bilgisi) için bir Slack kullanıcı belirteci (`xoxp-...`) kullanabilir. Varsayılan olarak bu salt-okunur kalır: mevcutsa okumalar kullanıcı belirtecini tercih eder, yazmalar ise siz açıkça etkinleştirmedikçe bot belirtecini kullanır. `userTokenReadOnly: false` olsa bile, bot belirteci mevcutken yazmalar için tercih edilir.

Kullanıcı belirteçleri yapılandırma dosyasında ayarlanır (ortam değişkeni desteği yoktur). Çoklu hesap için `channels.slack.accounts.<id>.userToken` ayarlayın.

Bot + app + kullanıcı belirteçleriyle örnek:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

userTokenReadOnly açıkça ayarlanmış örnek (kullanıcı belirteci yazmalarına izin verir):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Belirteç kullanımı

- Okuma işlemleri (geçmiş, tepkiler listesi, pinler listesi, emoji listesi, üye bilgisi,
  arama) yapılandırılmışsa kullanıcı belirtecini, aksi halde bot belirtecini tercih eder.
- Yazma işlemleri (mesaj gönderme/düzenleme/silme, tepki ekleme/kaldırma, pinleme/pinden çıkarma,
  dosya yüklemeleri) varsayılan olarak bot belirtecini kullanır. `userTokenReadOnly: false` ise ve
  bot belirteci yoksa, OpenClaw kullanıcı belirtecine geri döner.

### History context

- `channels.slack.historyLimit` (veya `channels.slack.accounts.*.historyLimit`) prompt içine sarılan son kanal/grup mesajı sayısını kontrol eder.
- `messages.groupChat.historyLimit`’e geri düşer. Devre dışı bırakmak için `0` ayarlayın (varsayılan 50).

## HTTP modu (Events API)

Gateway’iniz Slack tarafından HTTPS üzerinden erişilebilir olduğunda HTTP webhook modunu kullanın (sunucu dağıtımları için tipik).
HTTP modu, ortak bir istek URL’si ile Events API + Interactivity + Slash Commands kullanır.

### Kurulum (HTTP modu)

1. Bir Slack uygulaması oluşturun ve **Socket Mode**’u **devre dışı bırakın** (yalnızca HTTP kullanıyorsanız isteğe bağlı).
2. **Basic Information** → **Signing Secret**’ı kopyalayın.
3. **OAuth & Permissions** → uygulamayı yükleyin ve **Bot User OAuth Token**’ı (`xoxb-...`) kopyalayın.
4. **Event Subscriptions** → etkinleştirin ve **Request URL**’yi gateway webhook yolunuza ayarlayın (varsayılan `/slack/events`).
5. **Interactivity & Shortcuts** → etkinleştirin ve aynı **Request URL**’yi ayarlayın.
6. **Slash Commands** → komut(lar)ınız için aynı **Request URL**’yi ayarlayın.

Örnek istek URL’si:
`https://gateway-host/slack/events`

### OpenClaw yapılandırması (minimal)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Çoklu hesap HTTP modu: `channels.slack.accounts.<id>.mode = "http"` ayarlayın ve her Slack uygulamasının kendi URL’sine işaret edebilmesi için hesap başına benzersiz bir `webhookPath` sağlayın.

### Manifest (isteğe bağlı)

Uygulamayı hızlıca oluşturmak için bu Slack uygulama manifestini kullanın (isterseniz ad/komutu ayarlayın). Kullanıcı belirteci yapılandırmayı planlıyorsanız kullanıcı kapsamlarını ekleyin.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Yerel komutları etkinleştirirseniz, açığa çıkarmak istediğiniz her komut için bir `slash_commands` girdisi ekleyin (`/help` listesiyle eşleşmelidir). `channels.slack.commands.native` ile geçersiz kılın.

## Kapsamlar (mevcut vs isteğe bağlı)

Slack’in Conversations API’si tür-kapsamlıdır: yalnızca gerçekten dokunduğunuz konuşma türleri (channels, groups, im, mpim) için kapsamlar gerekir. Genel bakış için
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) adresine bakın.

### Bot token kapsamları (gerekli)

- `chat:write` (`chat.postMessage` üzerinden mesaj gönderme/güncelleme/silme)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (kullanıcı DM’leri için `conversations.open` ile DM açma)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (kullanıcı arama)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (`files.uploadV2` üzerinden yüklemeler)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### Kullanıcı token kapsamları (isteğe bağlı, varsayılan olarak salt-okunur)

`channels.slack.userToken` yapılandırırsanız bunları **User Token Scopes** altında ekleyin.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Bugün gerekli değil (ama muhtemelen gelecekte)

- `mpim:write` (yalnızca `conversations.open` ile grup-DM açma/DM başlatma eklersek)
- `groups:write` (yalnızca özel kanal yönetimi eklersek: oluştur/yeniden adlandır/davet/arşivle)
- `chat:write.public` (botun içinde olmadığı kanallara gönderi yapmak istersek)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (`users.info`’dan e‑posta alanlarına ihtiyaç duyarsak)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (dosya meta verilerini listelemeye/okumaya başlarsak)

## Yapılandırma

Slack yalnızca Socket Mode kullanır (HTTP webhook sunucusu yoktur). Her iki belirteci de sağlayın:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Tokens can also be supplied via env vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack tepkileri genel olarak `messages.ackReaction` +
`messages.ackReactionScope` ile kontrol edilir. Bot yanıtladıktan sonra
ack tepkisini temizlemek için `messages.removeAckAfterReply` kullanın.

## Sınırlar

- Giden metin `channels.slack.textChunkLimit`’ye bölünür (varsayılan 4000).
- İsteğe bağlı satır sonu bölme: uzunluk bölmeden önce boş satırlarda (paragraf sınırları) bölmek için `channels.slack.chunkMode="newline"` ayarlayın.
- Medya yüklemeleri `channels.slack.mediaMaxMb` ile sınırlandırılmıştır (varsayılan 20).

## Yanıt iş parçacığı (threading)

Varsayılan olarak OpenClaw ana kanalda yanıtlar. Otomatik threading’i kontrol etmek için `channels.slack.replyToMode` kullanın:

| Mod     | Davranış                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`   | **Varsayılan.** Ana kanalda yanıtla. Yalnızca tetikleyen mesaj zaten bir thread içindeyse thread’e gir.                                                            |
| `first` | İlk yanıt thread’e gider (tetikleyen mesajın altında), sonraki yanıtlar ana kanala gider. Bağlamı görünür tutarken thread karmaşasını azaltmak için yararlıdır. |
| `all`   | Tüm yanıtlar thread’e gider. Konuşmaları sınırlı tutar ancak görünürlüğü azaltabilir.                                                                                              |

Bu mod hem otomatik yanıtlar hem de ajan araç çağrıları (`slack sendMessage`) için geçerlidir.

### Sohbet türüne göre threading

`channels.slack.replyToModeByChatType` ayarlayarak sohbet türü başına farklı threading davranışı yapılandırabilirsiniz:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Desteklenen sohbet türleri:

- `direct`: 1:1 DM’ler (Slack `im`)
- `group`: grup DM’ler / MPIM’ler (Slack `mpim`)
- `channel`: standart kanallar (herkese açık/özel)

Öncelik sırası:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Sağlayıcı varsayılanı (`off`)

Eski `channels.slack.dm.replyToMode`, sohbet türü geçersiz kılma ayarlanmadığında `direct` için yedek olarak hâlâ kabul edilir.

Örnekler:

Yalnızca DM’leri thread’e al:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Grup DM’leri thread’e al, kanalları kökte bırak:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Kanalları thread’e al, DM’leri kökte bırak:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Manuel threading etiketleri

İnce ayar için ajan yanıtlarında şu etiketleri kullanın:

- `[[reply_to_current]]` — tetikleyen mesaja yanıtla (thread başlat/devam et).
- `[[reply_to:<id>]]` — belirli bir mesaj kimliğine yanıtla.

## Sessions + routing

- DM’ler `main` oturumunu paylaşır (WhatsApp/Telegram gibi).
- Kanallar `agent:<agentId>:slack:channel:<channelId>` oturumlarına eşlenir.
- Slash komutları `agent:<agentId>:slack:slash:<userId>` oturumlarını kullanır (ön ek `channels.slack.slashCommand.sessionPrefix` ile yapılandırılabilir).
- Slack `channel_type` sağlamazsa, OpenClaw bunu kanal kimliği önekinden (`D`, `C`, `G`) çıkarır ve oturum anahtarlarını kararlı tutmak için varsayılan olarak `channel`’yı kullanır.
- Yerel komut kaydı `commands.native` kullanır (genel varsayılan `"auto"` → Slack kapalı) ve çalışma alanı bazında `channels.slack.commands.native` ile geçersiz kılınabilir. Metin komutları bağımsız `/...` mesajları gerektirir ve `commands.text: false` ile devre dışı bırakılabilir. Slack slash komutları Slack uygulamasında yönetilir ve otomatik olarak kaldırılmaz. Komutlar için erişim-grubu denetimlerini atlamak üzere `commands.useAccessGroups: false` kullanın.
- Tam komut listesi + yapılandırma: [Slash commands](/tools/slash-commands)

## DM güvenliği (eşleştirme)

- Varsayılan: `channels.slack.dm.policy="pairing"` — bilinmeyen DM gönderenlere bir eşleştirme kodu verilir (1 saat sonra süresi dolar).
- Onaylama: `openclaw pairing approve slack <code>` üzerinden.
- Herkese izin vermek için: `channels.slack.dm.policy="open"` ve `channels.slack.dm.allowFrom=["*"]` ayarlayın.
- `channels.slack.dm.allowFrom` kullanıcı kimliklerini, @handle’ları veya e‑postaları kabul eder (belirteçler izin verdiğinde başlangıçta çözülür). Sihirbaz, kullanıcı adlarını kabul eder ve kurulum sırasında (belirteçler izin verdiğinde) bunları kimliklere çözer.

## Grup politikası

- `channels.slack.groupPolicy` kanal işlemeyi kontrol eder (`open|disabled|allowlist`).
- `allowlist`, kanalların `channels.slack.channels` içinde listelenmesini gerektirir.
- Yalnızca `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` ayarlayıp hiç `channels.slack` bölümü oluşturmazsanız,
  çalışma zamanı varsayılanları `groupPolicy`’i `open` olarak ayarlar. Kilitlemek için `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` veya bir kanal izin listesi ekleyin.
- Yapılandırma sihirbazı `#channel` adlarını kabul eder ve mümkün olduğunda kimliklere çözer
  (herkese açık + özel); birden fazla eşleşme varsa etkin kanalı tercih eder.
- Başlangıçta OpenClaw, izin listelerindeki kanal/kullanıcı adlarını (belirteçler izin verdiğinde)
  kimliklere çözer ve eşlemeyi günlüğe kaydeder; çözülemeyen girdiler yazıldığı gibi tutulur.
- **Hiç kanal**a izin vermemek için `channels.slack.groupPolicy: "disabled"` ayarlayın (veya boş bir izin listesi bırakın).

Kanal seçenekleri (`channels.slack.channels.<id>` veya `channels.slack.channels.<name>`):

- `allow`: `groupPolicy="allowlist"` iken kanala izin ver/reddet.
- `requireMention`: kanal için mention geçidi.
- `tools`: isteğe bağlı kanal başına araç politikası geçersiz kılmaları (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: kanal içinde gönderici başına isteğe bağlı araç politikası geçersiz kılmaları (anahtarlar gönderici kimlikleri/@handle’lar/e‑postalar; `"*"` joker karakteri desteklenir).
- `allowBots`: bu kanalda bot tarafından yazılan mesajlara izin ver (varsayılan: false).
- `users`: isteğe bağlı kanal başına kullanıcı izin listesi.
- `skills`: skill filtresi (atlanırsa = tüm skills, boş = hiçbiri).
- `systemPrompt`: kanal için ek sistem prompt’u (konu/amaç ile birleştirilir).
- `enabled`: kanalı devre dışı bırakmak için `false` ayarlayın.

## Teslim hedefleri

Cron/CLI gönderimleriyle birlikte kullanın:

- DM’ler için `user:<id>`
- Kanallar için `channel:<id>`

## Araç eylemleri

Slack araç eylemleri `channels.slack.actions.*` ile kapatılabilir:

| Eylem grubu | Varsayılan | Notlar                     |
| ----------- | ---------- | -------------------------- |
| reactions   | etkin      | Tepki ekle + listele       |
| messages    | etkin      | Oku/gönder/düzenle/sil     |
| pins        | etkin      | Pinle/pinden çıkar/listele |
| memberInfo  | etkin      | Üye bilgisi                |
| emojiList   | etkin      | Özel emoji listesi         |

## Güvenlik notları

- Yazmalar varsayılan olarak bot belirtecini kullanır; böylece durum değiştiren eylemler
  uygulamanın bot izinleri ve kimliğiyle sınırlı kalır.
- `userTokenReadOnly: false` ayarı, bot belirteci olmadığında kullanıcı belirtecinin yazma
  işlemleri için kullanılmasına izin verir; bu da eylemlerin uygulamayı yükleyen kullanıcının
  erişimiyle çalıştığı anlamına gelir. Kullanıcı belirtecini yüksek ayrıcalıklı kabul edin ve
  eylem kapılarını ve izin listelerini sıkı tutun.
- Kullanıcı belirteci yazmalarını etkinleştirirseniz, kullanıcı belirtecinin beklediğiniz yazma
  kapsamlarını içerdiğinden emin olun (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`); aksi halde bu işlemler başarısız olur.

## Sorun Giderme

Önce şu merdiveni çalıştırın:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Gerekirse DM eşleştirme durumunu doğrulayın:

```bash
openclaw pairing list slack
```

Yaygın hatalar:

- Bağlı ama kanallarda yanıt yok: kanal `groupPolicy` tarafından engellenmiş veya `channels.slack.channels` izin listesinde değil.
- DM’ler yok sayılıyor: `channels.slack.dm.policy="pairing"` iken gönderici onaylanmamış.
- API hataları (`missing_scope`, `not_in_channel`, kimlik doğrulama hataları): bot/app belirteçleri veya Slack kapsamları eksik.

Triyaj akışı için: [/channels/troubleshooting](/channels/troubleshooting).

## Notlar

- Mention geçidi `channels.slack.channels` ile kontrol edilir (`requireMention`’yi `true` olarak ayarlayın); `agents.list[].groupChat.mentionPatterns` (veya `messages.groupChat.mentionPatterns`) de mention olarak sayılır.
- Çoklu ajan geçersiz kılması: `agents.list[].groupChat.mentionPatterns` üzerinde ajan başına desenler ayarlayın.
- Tepki bildirimleri `channels.slack.reactionNotifications`’yi izler (`allowlist` modu ile `reactionAllowlist` kullanın).
- Bot tarafından yazılan mesajlar varsayılan olarak yok sayılır; `channels.slack.allowBots` veya `channels.slack.channels.<id>.allowBots` ile etkinleştirin.
- Uyarı: Diğer botlara yanıt vermeye izin verirseniz (`channels.slack.allowBots=true` veya `channels.slack.channels.<id>.allowBots=true`), botlar arası yanıt döngülerini `requireMention`, `channels.slack.channels.<id>.users` izin listeleri ve/veya `AGENTS.md` ile `SOUL.md` içindeki koruyucu sınırları temizleyerek önleyin.
- Slack aracı için tepki kaldırma semantiklerine [/tools/reactions](/tools/reactions) bölümünde bakın.
- Ekler, izin verildiğinde ve boyut sınırı altındaysa medya deposuna indirilir.
