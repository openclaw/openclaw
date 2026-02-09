---
summary: "Kanal bazında yönlendirme kuralları (WhatsApp, Telegram, Discord, Slack) ve paylaşılan bağlam"
read_when:
  - Kanal yönlendirmesi veya gelen kutusu davranışı değiştirildiğinde
title: "Kanal Yönlendirme"
---

# Kanallar ve yönlendirme

OpenClaw yanıtları **mesajın geldiği kanala geri** yönlendirir. Model bir kanal seçmez; yönlendirme deterministiktir ve ana makine yapılandırması tarafından kontrol edilir.

## Anahtar terimler

- **Kanal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: kanal başına hesap örneği (desteklendiğinde).
- **AgentId**: yalıtılmış bir çalışma alanı + oturum deposu (“beyin”).
- **SessionKey**: bağlamı depolamak ve eşzamanlılığı kontrol etmek için kullanılan kova anahtarı.

## Oturum anahtarı biçimleri (örnekler)

Doğrudan mesajlar, ajanın **ana** oturumunda toplanır:

- `agent:<agentId>:<mainKey>` (varsayılan: `agent:main:main`)

Gruplar ve kanallar, kanal bazında yalıtılmış kalır:

- Gruplar: `agent:<agentId>:<channel>:group:<id>`
- Kanallar/odalar: `agent:<agentId>:<channel>:channel:<id>`

Konular:

- Slack/Discord iş parçacıkları, temel anahtara `:thread:<threadId>` ekler.
- Telegram forum konuları, grup anahtarına `:topic:<topicId>` gömer.

Örnekler:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Yönlendirme kuralları (bir ajanın nasıl seçildiği)

Yönlendirme, gelen her mesaj için **tek bir ajan** seçer:

1. **Birebir eşleşme** (`bindings` ile `peer.kind` + `peer.id`).
2. **Guild eşleşmesi** (Discord) `guildId` üzerinden.
3. **Team eşleşmesi** (Slack) `teamId` üzerinden.
4. **Hesap eşleşmesi** (kanalda `accountId`).
5. **Kanal eşleşmesi** (o kanaldaki herhangi bir hesap).
6. **Varsayılan ajan** (`agents.list[].default`, aksi halde listedeki ilk giriş, geri dönüş olarak `main`).

Eşleşen ajan, hangi çalışma alanının ve oturum deposunun kullanılacağını belirler.

## Yayın grupları (birden fazla ajan çalıştırma)

Yayın grupları, OpenClaw’ın normalde yanıt vereceği durumlarda **aynı eş için birden fazla ajan** çalıştırmanıza olanak tanır (örneğin: WhatsApp gruplarında, bahsetme/etkinleştirme kapılamasından sonra).

Yapılandırma:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Bkz: [Broadcast Groups](/channels/broadcast-groups).

## Yapılandırmaya genel bakış

- `agents.list`: adlandırılmış ajan tanımları (çalışma alanı, model vb.).
- `bindings`: gelen kanalları/hesapları/eşleri ajanlara eşleyen harita.

Örnek:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Oturum depolama

Oturum depoları, durum dizini altında yer alır (varsayılan `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL dökümleri, depo ile aynı konumda bulunur

Depo yolunu `session.store` ve `{agentId}` şablonlaması ile geçersiz kılabilirsiniz.

## WebChat davranışı

WebChat **seçilen ajana** bağlanır ve varsayılan olarak ajanın ana oturumunu kullanır. Bu nedenle WebChat, o ajan için kanallar arası bağlamı tek bir yerde görmenizi sağlar.

## Yanıt bağlamı

Gelen yanıtlar şunları içerir:

- Mevcut olduğunda `ReplyToId`, `ReplyToBody` ve `ReplyToSender`.
- Alıntılanan bağlam, `Body`’e `[Replying to ...]` bloğu olarak eklenir.

Bu davranış kanallar arasında tutarlıdır.
