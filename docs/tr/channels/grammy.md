---
summary: "grammY üzerinden Telegram Bot API entegrasyonu ve kurulum notları"
read_when:
  - Telegram veya grammY yolları üzerinde çalışırken
title: grammY
---

# grammY Entegrasyonu (Telegram Bot API)

# Neden grammY

- TS-öncelikli Bot API istemcisi; yerleşik long-poll + webhook yardımcıları, middleware, hata yönetimi ve hız sınırlayıcı içerir.
- fetch + FormData’yı elle yazmaya kıyasla daha temiz medya yardımcıları; tüm Bot API yöntemlerini destekler.
- Genişletilebilir: özel fetch ile proxy desteği, oturum middleware’i (isteğe bağlı), tür güvenli bağlam.

# What we shipped

- **Tek istemci yolu:** fetch tabanlı uygulama kaldırıldı; grammY artık varsayılan olarak etkin olan grammY throttler ile tek Telegram istemcisidir (gönderme + gateway).
- **Gateway:** `monitorTelegramProvider` bir grammY `Bot` oluşturur; mention/allowlist kapılamasını bağlar, `getFile`/`download` üzerinden medya indirmeyi yapar ve yanıtları `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` ile iletir. `webhookCallback` üzerinden long-poll veya webhook’u destekler.
- **Proxy:** isteğe bağlı `channels.telegram.proxy`, grammY’nin `client.baseFetch`’i üzerinden `undici.ProxyAgent` kullanır.
- **Webhook desteği:** `webhook-set.ts`, `setWebhook/deleteWebhook`’u sarmalar; `webhook.ts` sağlık denetimi + zarif kapatma ile geri çağrıyı barındırır. Gateway, `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` ayarlandığında webhook modunu etkinleştirir (aksi halde long-poll yapar).
- **Oturumlar:** doğrudan sohbetler ajan ana oturumunda (`agent:<agentId>:<mainKey>`) birleştirilir; gruplar `agent:<agentId>:telegram:group:<chatId>` kullanır; yanıtlar aynı kanala yönlendirilir.
- **Yapılandırma ayarları:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention varsayılanları), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Taslak akışı:** isteğe bağlı `channels.telegram.streamMode`, özel konu sohbetlerinde `sendMessageDraft`’i kullanır (Bot API 9.3+). Bu, kanal blok halinde akıştan ayrıdır.
- **Testler:** grammY mock’ları DM + grup mention kapılamasını ve giden gönderimi kapsar; daha fazla medya/webhook fikstürü memnuniyetle karşılanır.

Açık sorular

- Bot API 429’larına takılırsak isteğe bağlı grammY eklentileri (throttler).
- Daha yapılandırılmış medya testleri eklemek (sticker’lar, sesli notlar).
- Webhook dinleme portunu yapılandırılabilir yapmak (şu anda gateway üzerinden bağlanmadıkça 8787’ye sabit).
