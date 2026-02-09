---
summary: "Integration med Telegram Bot API via grammY med anteckningar för konfigurering"
read_when:
  - Arbetar med Telegram- eller grammY-flöden
title: grammY
---

# grammY-integration (Telegram Bot API)

# Varför grammY

- TS-först Bot API-klient med inbyggda hjälpare för long-poll + webhook, middleware, felhantering och hastighetsbegränsare.
- Renare mediehjälpare än att handrulla fetch + FormData; stödjer alla Bot API-metoder.
- Utbyggbar: proxystöd via anpassad fetch, sessions-middleware (valfritt), typsäker kontext.

# Vad vi levererade

- **En enda klientväg:** fetch-baserad implementation borttagen; grammY är nu den enda Telegram-klienten (skicka + Gateway (nätverksgateway)) med grammY:s throttler aktiverad som standard.
- **Gateway:** `monitorTelegramProvider` bygger en grammatisk `Bot`, trådar nämner/tillåten lista gating, medianedladdning via `getFile`/`download`, och levererar svar med `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Stöder lång-undersökning eller webhook via `webhookCallback`.
- **Proxy:** valfri `channels.telegram.proxy` använder `undici.ProxyAgent` via grammY:s `client.baseFetch`.
- **Webhook stöd:** `webhook-set.ts` wraps `setWebhook/deleteWebhook`; `webhook.ts` är värd callback med hälsa + graciös avstängning. Gateway aktiverar webhook-läge när `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` är inställda (annars långpoller).
- **Sessioner:** direktchattar kollapsar till agentens huvudsession (`agent:<agentId>:<mainKey>`); grupper använder `agent:<agentId>:telegram:group:<chatId>`; svar routas tillbaka till samma kanal.
- **Konfig-knappar:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (tillåtelselista + standard för nämningar), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Utkast streaming:** valfria `channels.telegram.streamMode` använder `sendMessageDraft` i privata trådchattar (Bot API 9.3+). Detta är skilt från kanalblockets strömning.
- **Tester:** grammY-mockar täcker DM + gruppnämnings-gating och utgående sändning; fler fixturer för media/webhook välkomnas.

Öppna frågor

- Valfria grammY-plugins (throttler) om vi stöter på Bot API 429:or.
- Lägg till mer strukturerade medietester (klistermärken, röstmeddelanden).
- Gör webhookens lyssningsport konfigurerbar (för närvarande låst till 8787 om den inte kopplas via gatewayn).
