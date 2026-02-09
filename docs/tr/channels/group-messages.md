---
summary: "WhatsApp grup mesajı işleme davranışı ve yapılandırması (mentionPatterns yüzeyler arasında paylaşılır)"
read_when:
  - Grup mesajı kurallarını veya mention’ları değiştirirken
title: "Grup Mesajları"
---

# Grup mesajları (WhatsApp web kanalı)

Amaç: Clawd’un WhatsApp gruplarında bulunmasını, yalnızca pinglendiğinde uyanmasını ve bu başlığı kişisel DM oturumundan ayrı tutmayı sağlamak.

Not: `agents.list[].groupChat.mentionPatterns` artık Telegram/Discord/Slack/iMessage tarafından da kullanılıyor; bu doküman WhatsApp’e özgü davranışlara odaklanır. Çoklu ajan kurulumları için, ajan başına `agents.list[].groupChat.mentionPatterns` ayarlayın (veya genel bir geri dönüş olarak `messages.groupChat.mentionPatterns` kullanın).

## What’s implemented (2025-12-03)

- Etkinleştirme modları: `mention` (varsayılan) veya `always`. `mention` bir ping gerektirir ( `mentionedJids` üzerinden gerçek WhatsApp @-mention’ları, regex desenleri veya botun E.164 numarasının metin içinde herhangi bir yerde geçmesi). `always` ajanı her mesajda uyandırır ancak yalnızca anlamlı değer katabildiğinde yanıt vermelidir; aksi halde sessiz belirteç `NO_REPLY` döndürür. Varsayılanlar yapılandırmada (`channels.whatsapp.groups`) ayarlanabilir ve grup bazında `/activation` ile geçersiz kılınabilir. `channels.whatsapp.groups` ayarlandığında, bir grup izin listesi olarak da davranır (tümüne izin vermek için `"*"` ekleyin).
- Grup politikası: `channels.whatsapp.groupPolicy`, grup mesajlarının kabul edilip edilmeyeceğini (`open|disabled|allowlist`) denetler. `allowlist`, `channels.whatsapp.groupAllowFrom`’yi kullanır (geri dönüş: açık `channels.whatsapp.allowFrom`). Varsayılan `allowlist`’dur (gönderenler eklenene kadar engelli).
- Grup başına oturumlar: oturum anahtarları `agent:<agentId>:whatsapp:group:<jid>` gibi görünür; böylece `/verbose on` veya `/think high` gibi komutlar (tek başına mesaj olarak gönderildiğinde) o gruba kapsamlanır; kişisel DM durumu etkilenmez. Grup başlıkları için heartbeat’ler atlanır.
- Bağlam enjeksiyonu: çalıştırmayı tetiklemeyen **yalnızca bekleyen** grup mesajları (varsayılan 50), `[Chat messages since your last reply - for context]` altında öneklenir; tetikleyici satır `[Current message - respond to this]` altında yer alır. Oturumda zaten bulunan mesajlar yeniden enjekte edilmez.
- Gönderenin görünür kılınması: her grup yığını artık `[from: Sender Name (+E164)]` ile biter; böylece Pi kimin konuştuğunu bilir.
- Geçici/tek-görünüm: metni/mention’ları çıkarmadan önce bunları açarız; böylece içlerindeki ping’ler de tetikler.
- Grup sistem istemi: bir grup oturumunun ilk turunda (ve `/activation` modu değiştirdiğinde) sistem istemine `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` gibi kısa bir açıklama enjekte ederiz. Meta veriler yoksa bile ajana bunun bir grup sohbeti olduğunu söyleriz.

## Yapılandırma örneği (WhatsApp)

WhatsApp metin gövdesinde görsel `@`’yi kaldırsa bile görünen ad ping’lerinin çalışması için `~/.openclaw/openclaw.json`’a bir `groupChat` bloğu ekleyin:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notlar:

- Regex’ler büyük/küçük harfe duyarsızdır; `@openclaw` gibi bir görünen ad ping’ini ve ham numarayı `+`/boşluklarla veya bunlar olmadan kapsar.
- Birisi kişiye dokunduğunda WhatsApp hâlâ `mentionedJids` üzerinden kanonik mention’lar gönderir; bu nedenle numara geri dönüşü nadiren gerekir ancak yararlı bir güvenlik ağıdır.

### Etkinleştirme komutu (yalnızca sahip)

Grup sohbeti komutunu kullanın:

- `/activation mention`
- `/activation always`

Bunu yalnızca sahip numarası (`channels.whatsapp.allowFrom`’dan; ayarlı değilse botun kendi E.164’ü) değiştirebilir. Geçerli etkinleştirme modunu görmek için grupta tek başına mesaj olarak `/status` gönderin.

## Nasıl kullanılır

1. WhatsApp hesabınızı (OpenClaw çalıştıran) gruba ekleyin.
2. `@openclaw …` deyin (veya numarayı ekleyin). `groupPolicy: "open"` ayarlamadıkça yalnızca izin listesinde olan gönderenler tetikleyebilir.
3. Ajan istemi, son grup bağlamını ve doğru kişiye hitap edebilmesi için sondaki `[from: …]` işaretini içerir.
4. Oturum düzeyi yönergeler (`/verbose on`, `/think high`, `/new` veya `/reset`, `/compact`) yalnızca o grubun oturumuna uygulanır; kaydolmaları için tek başına mesaj olarak gönderin. Kişisel DM oturumunuz bağımsız kalır.

## Test / doğrulama

- Manual smoke:
  - Grupta bir `@openclaw` ping’i gönderin ve gönderen adını referans alan bir yanıtı doğrulayın.
  - İkinci bir ping gönderin ve geçmiş bloğunun dahil edildiğini, ardından bir sonraki turda temizlendiğini doğrulayın.
- Gateway günlüklerini (`--verbose` ile çalıştırın) kontrol ederek `from: <groupJid>`’u ve `[from: …]` son ekini gösteren `inbound web message` girdilerini görün.

## Bilinen hususlar

- Gürültülü yayınları önlemek için gruplarda heartbeat’ler bilinçli olarak atlanır.
- Yankı bastırma, birleştirilmiş yığın dizesini kullanır; mention olmadan aynı metni iki kez gönderirseniz yalnızca ilki yanıt alır.
- Oturum deposu girdileri, oturum deposunda (`~/.openclaw/agents/<agentId>/sessions/sessions.json` varsayılan) `agent:<agentId>:whatsapp:group:<jid>` olarak görünür; eksik bir giriş, grubun henüz bir çalıştırmayı tetiklemediği anlamına gelir.
- Gruplardaki yazma göstergeleri `agents.defaults.typingMode`’ü izler (varsayılan: mention yokken `message`).
