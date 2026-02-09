---
summary: "Yüzeyler arasında grup sohbeti davranışı (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Grup sohbeti davranışını veya mention gating’i değiştirirken
title: "Gruplar"
---

# Gruplar

OpenClaw, grup sohbetlerini tüm yüzeylerde tutarlı şekilde ele alır: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Başlangıç için giriş (2 dakika)

OpenClaw kendi mesajlaşma hesaplarınızda “yaşar”. Ayrı bir WhatsApp bot kullanıcısı yoktur.
**Siz** bir gruptaysanız, OpenClaw o grubu görebilir ve orada yanıt verebilir.

Varsayılan davranış:

- Gruplar kısıtlıdır (`groupPolicy: "allowlist"`).
- Açıkça mention gating’i devre dışı bırakmadıkça yanıtlar mention gerektirir.

Çeviri: izin listesine alınmış gönderenler, OpenClaw’ı mention ederek tetikleyebilir.

> TL;DR
>
> - **DM erişimi** `*.allowFrom` ile kontrol edilir.
> - **Grup erişimi** `*.groupPolicy` + izin listeleri (`*.groups`, `*.groupAllowFrom`) ile kontrol edilir.
> - **Yanıt tetikleme** mention gating (`requireMention`, `/activation`) ile kontrol edilir.

Hızlı akış (bir grup mesajına ne olur):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Grup mesajı akışı](/images/groups-flow.svg)

İsterseniz...

| Amaç                                                                 | What to set                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tüm gruplara izin ver ama yalnızca @mention ile yanıtla | `groups: { "*": { requireMention: true } }`                                 |
| Tüm grup yanıtlarını devre dışı bırak                                | `groupPolicy: "disabled"`                                                   |
| Yalnızca belirli gruplar                                             | `groups: { "<group-id>": { ... } }` (`"*"` anahtarı yok) |
| Gruplarda yalnızca siz tetikleyebilirsiniz                           | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                  |

## Oturum anahtarları

- Grup oturumları `agent:<agentId>:<channel>:group:<id>` oturum anahtarlarını kullanır (odalar/kanallar `agent:<agentId>:<channel>:channel:<id>` kullanır).
- Telegram forum konuları, her konunun kendi oturumu olması için grup kimliğine `:topic:<threadId>` ekler.
- Doğrudan sohbetler ana oturumu kullanır (veya yapılandırıldıysa gönderen başına).
- Grup oturumları için heartbeat’ler atlanır.

## Desen: kişisel DM’ler + herkese açık gruplar (tek ajan)

Evet — “kişisel” trafiğiniz **DM’ler** ve “herkese açık” trafiğiniz **gruplar** ise bu iyi çalışır.

Neden: tek ajan modunda DM’ler genellikle **ana** oturum anahtarına (`agent:main:main`) düşer; gruplar ise her zaman **ana olmayan** oturum anahtarlarını (`agent:main:<channel>:group:<id>`) kullanır. `mode: "non-main"` ile sandboxing’i etkinleştirirseniz, bu grup oturumları Docker’da çalışırken ana DM oturumunuz ana makinede kalır.

Bu size tek bir ajan “beyni” (paylaşılan çalışma alanı + bellek) fakat iki yürütme duruşu sağlar:

- **DM’ler**: tam araçlar (ana makine)
- **Gruplar**: sandbox + kısıtlı araçlar (Docker)

> Gerçekten ayrı çalışma alanları/kişilikler gerekiyorsa (“kişisel” ve “herkese açık” asla karışmamalı), ikinci bir ajan + bağlamalar kullanın. Bkz. [Çoklu Ajan Yönlendirme](/concepts/multi-agent).

Örnek (DM’ler ana makinede, gruplar sandbox’ta + yalnızca mesajlaşma araçları):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Want “groups can only see folder X” instead of “no host access”? “Ana makine erişimi yok” yerine “gruplar yalnızca X klasörünü görebilir” istiyorsanız, `workspaceAccess: "none"`’u koruyun ve sandbox’a yalnızca izin listesine alınmış yolları bağlayın:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

İlgili:

- Yapılandırma anahtarları ve varsayılanlar: [Gateway yapılandırması](/gateway/configuration#agentsdefaultssandbox)
- Bir aracın neden engellendiğini ayıklama: [Sandbox vs Araç Politikası vs Yükseltilmiş](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Bind mount ayrıntıları: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Görüntü etiketleri

- UI etiketleri, mevcut olduğunda `displayName` kullanır ve `<channel>:<token>` biçiminde formatlanır.
- `#room` odalar/kanallar için ayrılmıştır; grup sohbetleri `g-<slug>` kullanır (küçük harf, boşluklar -> `-`, `#@+._-` korunur).

## Grup politikası

Kanal başına grup/oda mesajlarının nasıl ele alınacağını kontrol edin:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Politika      | Davranış                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| `"open"`      | Gruplar izin listelerini atlar; mention gating yine de geçerlidir.            |
| `"disabled"`  | Tüm grup mesajlarını tamamen engeller.                                        |
| `"allowlist"` | Yalnızca yapılandırılmış izin listesiyle eşleşen gruplara/odalara izin verir. |

Notlar:

- `groupPolicy`, mention gating’den ayrıdır (mention için @ gerektirir).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` kullanın (geri dönüş: açık `allowFrom`).
- Discord: izin listesi `channels.discord.guilds.<id>.channels` kullanır.
- Slack: izin listesi `channels.slack.channels` kullanır.
- Matrix: izin listesi `channels.matrix.groups` kullanır (oda kimlikleri, takma adlar veya adlar). Gönderenleri kısıtlamak için `channels.matrix.groupAllowFrom` kullanın; oda başına `users` izin listeleri de desteklenir.
- Grup DM’leri ayrı olarak kontrol edilir (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram izin listesi kullanıcı kimlikleriyle (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) veya kullanıcı adlarıyla (`"@alice"` veya `"alice"`) eşleşebilir; önekler büyük/küçük harfe duyarsızdır.
- Varsayılan `groupPolicy: "allowlist"`’tür; grup izin listeniz boşsa grup mesajları engellenir.

Hızlı zihinsel model (grup mesajları için değerlendirme sırası):

1. `groupPolicy` (open/disabled/allowlist)
2. grup izin listeleri (`*.groups`, `*.groupAllowFrom`, kanala özgü izin listesi)
3. mention gating (`requireMention`, `/activation`)

## Mention gating (varsayılan)

Grup mesajları, grup başına geçersiz kılınmadıkça mention gerektirir. Varsayılanlar, alt sistem başına `*.groups."*"` altında yer alır.

Bir bot mesajına yanıt vermek, kanal yanıt meta verilerini desteklediğinde örtük bir mention sayılır. Bu, Telegram, WhatsApp, Slack, Discord ve Microsoft Teams için geçerlidir.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Notlar:

- `mentionPatterns` büyük/küçük harfe duyarsız regex’lerdir.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- Ajan başına geçersiz kılma: `agents.list[].groupChat.mentionPatterns` (birden fazla ajanın aynı grubu paylaştığı durumlarda yararlıdır).
- Mention gating yalnızca mention tespiti mümkün olduğunda uygulanır (yerel mention’lar veya `mentionPatterns` yapılandırıldığında).
- Discord varsayılanları `channels.discord.guilds."*"`’te yer alır (guild/kanal başına geçersiz kılınabilir).
- Grup geçmişi bağlamı, kanallar arasında tutarlı biçimde sarılır ve **yalnızca beklemede**dir (mention gating nedeniyle atlanan mesajlar); genel varsayılan için `messages.groupChat.historyLimit`, geçersiz kılmalar için `channels.<channel>.historyLimit` (veya `channels.<channel>.accounts.*.historyLimit`) kullanın. Devre dışı bırakmak için `0` ayarlayın.

## Grup/kanal araç kısıtlamaları (isteğe bağlı)

Bazı kanal yapılandırmaları, **belirli bir grup/oda/kanal içinde** hangi araçların kullanılabileceğini kısıtlamayı destekler.

- `tools`: tüm grup için araçlara izin ver/engelle.
- `toolsBySender`: grup içinde gönderen başına geçersiz kılmalar (anahtarlar, kanala bağlı olarak gönderen kimlikleri/kullanıcı adları/e-postalar/telefon numaralarıdır). Joker olarak `"*"` kullanın.

Çözümleme sırası (en özeli kazanır):

1. grup/kanal `toolsBySender` eşleşmesi
2. grup/kanal `tools`
3. varsayılan (`"*"`) `toolsBySender` eşleşmesi
4. varsayılan (`"*"`) `tools`

Örnek (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Notlar:

- Grup/kanal araç kısıtlamaları, genel/ajan araç politikasına ek olarak uygulanır (engelleme her zaman kazanır).
- Bazı kanallar odalar/kanallar için farklı iç içe yerleşim kullanır (ör. Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Grup izin listeleri

`channels.whatsapp.groups`, `channels.telegram.groups` veya `channels.imessage.groups` yapılandırıldığında, bu anahtarlar bir grup izin listesi olarak davranır. Varsayılan mention davranışını ayarlarken tüm gruplara izin vermek için `"*"` kullanın.

Yaygın amaçlar (kopyala/yapıştır):

1. Tüm grup yanıtlarını devre dışı bırak

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Yalnızca belirli gruplara izin ver (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Tüm gruplara izin ver ama mention iste (açık)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Gruplarda yalnızca sahibi tetikleyebilir (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Etkinleştirme (yalnızca sahip)

Grup sahipleri, grup başına etkinleştirmeyi açıp kapatabilir:

- `/activation mention`
- `/activation always`

Sahip, `channels.whatsapp.allowFrom` ile belirlenir (ayarlanmadıysa botun kendi E.164’ü). Komutu tek başına bir mesaj olarak gönderin. Diğer yüzeyler şu anda `/activation`’i yok sayar.

## Bağlam alanları

Grup gelen payload’ları şunları ayarlar:

- `ChatType=group`
- `GroupSubject` (biliniyorsa)
- `GroupMembers` (biliniyorsa)
- `WasMentioned` (mention gating sonucu)
- Telegram forum konuları ayrıca `MessageThreadId` ve `IsForum` içerir.

Ajan sistem istemi, yeni bir grup oturumunun ilk turunda bir grup girişi içerir. Modeli insan gibi yanıtlaması, Markdown tablolarından kaçınması ve `\n` dizilerini harfiyen yazmaktan kaçınması için hatırlatır.

## iMessage ayrıntıları

- Yönlendirme veya izin listesine alma sırasında `chat_id:<id>`’yı tercih edin.
- Sohbetleri listeleme: `imsg chats --limit 20`.
- Grup yanıtları her zaman aynı `chat_id`’e geri gider.

## WhatsApp ayrıntıları

WhatsApp’a özgü davranışlar (geçmiş enjeksiyonu, mention işleme ayrıntıları) için [Grup mesajları](/channels/group-messages) bölümüne bakın.
