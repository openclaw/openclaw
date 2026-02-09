---
summary: "Integrasyon ng Telegram Bot API sa pamamagitan ng grammY na may mga tala sa setup"
read_when:
  - Kapag nagtatrabaho sa mga pathway ng Telegram o grammY
title: grammY
---

# Integrasyon ng grammY (Telegram Bot API)

# Bakit grammY

- TS-first na Bot API client na may built-in na long-poll + webhook helpers, middleware, error handling, at rate limiter.
- Mas malinis na media helpers kumpara sa mano-manong fetch + FormData; sinusuportahan ang lahat ng Bot API methods.
- Extensible: proxy support sa pamamagitan ng custom fetch, session middleware (opsyonal), at type-safe na context.

# Ano ang naihatid namin

- **Iisang client path:** tinanggal ang fetch-based na implementasyon; ang grammY na ngayon ang tanging Telegram client (send + gateway) na may grammY throttler na naka-enable bilang default.
- Mga karaniwang sanhi: **Hindi naka-configure ang channel**: Nawawala ang seksyong `channels.googlechat` sa iyong config.
- **Proxy:** opsyonal na `channels.telegram.proxy` gumagamit ng `undici.ProxyAgent` sa pamamagitan ng `client.baseFetch` ng grammY.
- **Gateway:** Ang `monitorTelegramProvider` ay bumubuo ng isang grammY `Bot`, ikinakabit ang mention/allowlist gating, pag-download ng media sa pamamagitan ng `getFile`/`download`, at naghahatid ng mga sagot gamit ang `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Gateway enables webhook mode when `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` are set (otherwise it long-polls).
- **Mga session:** ang mga direct chat ay pinagsasama sa pangunahing session ng agent (`agent:<agentId>:<mainKey>`); ang mga group ay gumagamit ng `agent:<agentId>:telegram:group:<chatId>`; ang mga reply ay niruruta pabalik sa parehong channel.
- **Mga config knob:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (mga default ng allowlist + mention), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Suporta sa webhook:** Ang `webhook-set.ts` ay nagbabalot ng `setWebhook/deleteWebhook`; ang `webhook.ts` ay nagho-host ng callback na may health + maayos na shutdown. Pinapagana ng gateway ang webhook mode kapag naka-set ang `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (kung hindi, long-poll ang gamit).
- **Mga test:** sinasaklaw ng grammY mocks ang DM + group mention gating at outbound send; mas marami pang media/webhook fixtures ang malugod na tinatanggap.

Mga bukas na tanong

- Mga opsyonal na grammY plugin (throttler) kung makaranas tayo ng Bot API 429s.
- Magdagdag ng mas structured na media tests (stickers, voice notes).
- Gawing configurable ang webhook listen port (kasalukuyang naka-fix sa 8787 maliban kung i-wire sa pamamagitan ng Gateway).
