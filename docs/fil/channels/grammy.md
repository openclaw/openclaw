---
summary: "Integrasyon ng Telegram Bot API sa pamamagitan ng grammY na may mga tala sa setup"
read_when:
  - Kapag nagtatrabaho sa mga pathway ng Telegram o grammY
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:19Z
---

# Integrasyon ng grammY (Telegram Bot API)

# Bakit grammY

- TS-first na Bot API client na may built-in na long-poll + webhook helpers, middleware, error handling, at rate limiter.
- Mas malinis na media helpers kumpara sa mano-manong fetch + FormData; sinusuportahan ang lahat ng Bot API methods.
- Extensible: proxy support sa pamamagitan ng custom fetch, session middleware (opsyonal), at type-safe na context.

# Ano ang naihatid namin

- **Iisang client path:** tinanggal ang fetch-based na implementasyon; ang grammY na ngayon ang tanging Telegram client (send + gateway) na may grammY throttler na naka-enable bilang default.
- **Gateway:** `monitorTelegramProvider` bumubuo ng isang grammY `Bot`, ikinakabit ang mention/allowlist gating, media download sa pamamagitan ng `getFile`/`download`, at naghahatid ng mga reply gamit ang `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Sinusuportahan ang long-poll o webhook sa pamamagitan ng `webhookCallback`.
- **Proxy:** opsyonal na `channels.telegram.proxy` gumagamit ng `undici.ProxyAgent` sa pamamagitan ng `client.baseFetch` ng grammY.
- **Suporta sa webhook:** `webhook-set.ts` nagbabalot ng `setWebhook/deleteWebhook`; `webhook.ts` nagho-host ng callback na may health + graceful shutdown. Ini-enable ng Gateway ang webhook mode kapag naka-set ang `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (kung hindi, magla-long-poll ito).
- **Mga session:** ang mga direct chat ay pinagsasama sa pangunahing session ng agent (`agent:<agentId>:<mainKey>`); ang mga group ay gumagamit ng `agent:<agentId>:telegram:group:<chatId>`; ang mga reply ay niruruta pabalik sa parehong channel.
- **Mga config knob:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (mga default ng allowlist + mention), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Draft streaming:** opsyonal na `channels.telegram.streamMode` gumagamit ng `sendMessageDraft` sa mga private topic chat (Bot API 9.3+). Hiwalay ito mula sa channel block streaming.
- **Mga test:** sinasaklaw ng grammY mocks ang DM + group mention gating at outbound send; mas marami pang media/webhook fixtures ang malugod na tinatanggap.

Mga bukas na tanong

- Mga opsyonal na grammY plugin (throttler) kung makaranas tayo ng Bot API 429s.
- Magdagdag ng mas structured na media tests (stickers, voice notes).
- Gawing configurable ang webhook listen port (kasalukuyang naka-fix sa 8787 maliban kung i-wire sa pamamagitan ng Gateway).
