---
summary: "OpenClaw’un bağlanabildiği mesajlaşma platformları"
read_when:
  - OpenClaw için bir sohbet kanalı seçmek istiyorsunuz
  - Desteklenen mesajlaşma platformlarına hızlı bir genel bakışa ihtiyacınız var
title: "Sohbet Kanalları"
---

# Sohbet Kanalları

OpenClaw, halihazırda kullandığınız herhangi bir sohbet uygulaması üzerinden sizinle konuşabilir. Her kanal Gateway üzerinden bağlanır.
Metin her yerde desteklenir; medya ve tepkiler kanala göre değişir.

## Desteklenen kanallar

- [WhatsApp](/channels/whatsapp) — En popüler; Baileys kullanır ve QR eşleştirmesi gerektirir.
- [Telegram](/channels/telegram) — grammY üzerinden Bot API; grupları destekler.
- [Discord](/channels/discord) — Discord Bot API + Gateway; sunucuları, kanalları ve DM'leri destekler.
- [Slack](/channels/slack) — Bolt SDK; çalışma alanı uygulamaları.
- [Feishu](/channels/feishu) — WebSocket üzerinden Feishu/Lark botu (eklenti, ayrı olarak kurulur).
- [Google Chat](/channels/googlechat) — HTTP webhook üzerinden Google Chat API uygulaması.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kanallar, gruplar, DM'ler (eklenti, ayrı olarak kurulur).
- [Signal](/channels/signal) — signal-cli; gizlilik odaklı.
- [BlueBubbles](/channels/bluebubbles) — **iMessage için önerilir**; tam özellik desteğiyle (düzenleme, geri alma, efektler, tepkiler, grup yönetimi — düzenleme şu anda macOS 26 Tahoe’da bozuk) BlueBubbles macOS sunucu REST API’sini kullanır.
- [iMessage (legacy)](/channels/imessage) — imsg CLI üzerinden eski macOS entegrasyonu (kullanımdan kaldırıldı, yeni kurulumlar için BlueBubbles kullanın).
- [Microsoft Teams](/channels/msteams) — Bot Framework; kurumsal destek (eklenti, ayrı olarak kurulur).
- [LINE](/channels/line) — LINE Messaging API botu (eklenti, ayrı olarak kurulur).
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk üzerinden self-hosted sohbet (eklenti, ayrı olarak kurulur).
- [Matrix](/channels/matrix) — Matrix protokolü (eklenti, ayrı olarak kurulur).
- [Nostr](/channels/nostr) — NIP-04 üzerinden merkeziyetsiz DM'ler (eklenti, ayrı olarak kurulur).
- [Tlon](/channels/tlon) — Urbit tabanlı mesajlaşma uygulaması (eklenti, ayrı olarak kurulur).
- [Twitch](/channels/twitch) — IRC bağlantısı üzerinden Twitch sohbeti (eklenti, ayrı olarak kurulur).
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnam’ın popüler mesajlaşma uygulaması (eklenti, ayrı olarak kurulur).
- [Zalo Personal](/channels/zalouser) — QR oturum açma ile Zalo kişisel hesabı (eklenti, ayrı olarak kurulur).
- [WebChat](/web/webchat) — WebSocket üzerinden Gateway WebChat arayüzü.

## Notlar

- Kanallar eşzamanlı çalışabilir; birden fazlasını yapılandırın ve OpenClaw sohbet başına yönlendirsin.
- En hızlı kurulum genellikle **Telegram**’dır (basit bot belirteci). WhatsApp QR eşleştirmesi gerektirir ve
  diskte daha fazla durum bilgisi saklar.
- Grup davranışı kanala göre değişir; bkz. [Gruplar](/channels/groups).
- DM eşleştirmesi ve izin listeleri güvenlik için uygulanır; bkz. [Güvenlik](/gateway/security).
- Telegram iç detayları: [grammY notları](/channels/grammy).
- Sorun giderme: [Kanal sorun giderme](/channels/troubleshooting).
- Model sağlayıcıları ayrı olarak belgelenmiştir; bkz. [Model Sağlayıcıları](/providers/models).
