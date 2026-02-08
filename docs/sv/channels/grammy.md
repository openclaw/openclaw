---
summary: "Integration med Telegram Bot API via grammY med anteckningar för konfigurering"
read_when:
  - Arbetar med Telegram- eller grammY-flöden
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:16Z
---

# grammY-integration (Telegram Bot API)

# Varför grammY

- TS-först Bot API-klient med inbyggda hjälpare för long-poll + webhook, middleware, felhantering och hastighetsbegränsare.
- Renare mediehjälpare än att handrulla fetch + FormData; stödjer alla Bot API-metoder.
- Utbyggbar: proxystöd via anpassad fetch, sessions-middleware (valfritt), typsäker kontext.

# Vad vi levererade

- **En enda klientväg:** fetch-baserad implementation borttagen; grammY är nu den enda Telegram-klienten (skicka + Gateway (nätverksgateway)) med grammY:s throttler aktiverad som standard.
- **Gateway:** `monitorTelegramProvider` bygger en grammY `Bot`, kopplar nämnings-/tillåtelseliste-gating, medienedladdning via `getFile`/`download`, och levererar svar med `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Stöder long-poll eller webhook via `webhookCallback`.
- **Proxy:** valfri `channels.telegram.proxy` använder `undici.ProxyAgent` via grammY:s `client.baseFetch`.
- **Webhook-stöd:** `webhook-set.ts` omsluter `setWebhook/deleteWebhook`; `webhook.ts` hostar callbacken med hälsokontroll + graciös nedstängning. Gateway (nätverksgateway) aktiverar webhook-läge när `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` är satta (annars används long-poll).
- **Sessioner:** direktchattar kollapsar till agentens huvudsession (`agent:<agentId>:<mainKey>`); grupper använder `agent:<agentId>:telegram:group:<chatId>`; svar routas tillbaka till samma kanal.
- **Konfig-knappar:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (tillåtelselista + standard för nämningar), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Utkaststreaming:** valfri `channels.telegram.streamMode` använder `sendMessageDraft` i privata ämneschattar (Bot API 9.3+). Detta är separat från kanalens blockstreaming.
- **Tester:** grammY-mockar täcker DM + gruppnämnings-gating och utgående sändning; fler fixturer för media/webhook välkomnas.

Öppna frågor

- Valfria grammY-plugins (throttler) om vi stöter på Bot API 429:or.
- Lägg till mer strukturerade medietester (klistermärken, röstmeddelanden).
- Gör webhookens lyssningsport konfigurerbar (för närvarande låst till 8787 om den inte kopplas via gatewayn).
