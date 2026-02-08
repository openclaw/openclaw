---
summary: "Telegram Bot API-integration via grammY med opsætningsnoter"
read_when:
  - Arbejder med Telegram- eller grammY-forløb
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:50Z
---

# grammY-integration (Telegram Bot API)

# Hvorfor grammY

- TS-first Bot API-klient med indbygget long-poll + webhook-hjælpere, middleware, fejlhåndtering og rate limiter.
- Renere mediehjælpere end hjemmerullet fetch + FormData; understøtter alle Bot API-metoder.
- Udvidelig: proxy-understøttelse via custom fetch, session-middleware (valgfrit), typesikker context.

# Det, vi har leveret

- **Enkelt klientspor:** fetch-baseret implementering er fjernet; grammY er nu den eneste Telegram-klient (send + gateway) med grammY-throttler aktiveret som standard.
- **Gateway:** `monitorTelegramProvider` bygger en grammY `Bot`, kobler mention-/tilladelsesliste-gating, mediedownload via `getFile`/`download`, og leverer svar med `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Understøtter long-poll eller webhook via `webhookCallback`.
- **Proxy:** valgfri `channels.telegram.proxy` bruger `undici.ProxyAgent` gennem grammY’s `client.baseFetch`.
- **Webhook-understøttelse:** `webhook-set.ts` wrapper `setWebhook/deleteWebhook`; `webhook.ts` hoster callback med health + graceful shutdown. Gateway aktiverer webhook-tilstand, når `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` er sat (ellers long-poller den).
- **Sessioner:** direkte chats kollapser ind i agentens hovedsession (`agent:<agentId>:<mainKey>`); grupper bruger `agent:<agentId>:telegram:group:<chatId>`; svar routes tilbage til samme kanal.
- **Konfigurationsknapper:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (tilladelsesliste + mention-standarder), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Kladde-streaming:** valgfri `channels.telegram.streamMode` bruger `sendMessageDraft` i private emnechats (Bot API 9.3+). Dette er adskilt fra kanalens blokstreaming.
- **Tests:** grammY-mocks dækker DM + gruppe-mention-gating og udgående send; flere medie-/webhook-fixtures er stadig velkomne.

Åbne spørgsmål

- Valgfrie grammY-plugins (throttler), hvis vi rammer Bot API 429’er.
- Tilføj flere strukturerede medietests (stickers, stemmenoter).
- Gør webhook-lytteporten konfigurerbar (pt. fast til 8787, medmindre den kobles via gatewayen).
