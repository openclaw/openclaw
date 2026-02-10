---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Telegram Bot API integration via grammY with setup notes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Telegram or grammY pathways（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: grammY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# grammY Integration (Telegram Bot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Why grammY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TS-first Bot API client with built-in long-poll + webhook helpers, middleware, error handling, rate limiter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cleaner media helpers than hand-rolling fetch + FormData; supports all Bot API methods.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extensible: proxy support via custom fetch, session middleware (optional), type-safe context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# What we shipped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Single client path:** fetch-based implementation removed; grammY is now the sole Telegram client (send + gateway) with the grammY throttler enabled by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway:** `monitorTelegramProvider` builds a grammY `Bot`, wires mention/allowlist gating, media download via `getFile`/`download`, and delivers replies with `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Supports long-poll or webhook via `webhookCallback`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Proxy:** optional `channels.telegram.proxy` uses `undici.ProxyAgent` through grammY’s `client.baseFetch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Webhook support:** `webhook-set.ts` wraps `setWebhook/deleteWebhook`; `webhook.ts` hosts the callback with health + graceful shutdown. Gateway enables webhook mode when `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` are set (otherwise it long-polls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sessions:** direct chats collapse into the agent main session (`agent:<agentId>:<mainKey>`); groups use `agent:<agentId>:telegram:group:<chatId>`; replies route back to the same channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention defaults), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Draft streaming:** optional `channels.telegram.streamMode` uses `sendMessageDraft` in private topic chats (Bot API 9.3+). This is separate from channel block streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tests:** grammy mocks cover DM + group mention gating and outbound send; more media/webhook fixtures still welcome.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional grammY plugins (throttler) if we hit Bot API 429s.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add more structured media tests (stickers, voice notes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make webhook listen port configurable (currently fixed to 8787 unless wired through the gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
