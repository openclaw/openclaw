---
summary: "Integratie met de Telegram Bot API via grammY met installatienotities"
read_when:
  - Werken aan Telegram- of grammY-trajecten
title: grammY
---

# grammY-integratie (Telegram Bot API)

# Waarom grammY

- TS-first Bot API-client met ingebouwde long-poll- en webhook-helpers, middleware, foutafhandeling en rate limiter.
- Schonere media-helpers dan zelf fetch + FormData samenstellen; ondersteunt alle Bot API-methoden.
- Uitbreidbaar: proxy-ondersteuning via aangepaste fetch, sessiemiddleware (optioneel), type-veilige context.

# Wat we hebben geleverd

- **Enkel clientpad:** fetch-gebaseerde implementatie verwijderd; grammY is nu de enige Telegram-client (verzenden + Gateway) met de grammY-throttler standaard ingeschakeld.
- **Gateway:** `monitorTelegramProvider` bouwt een grammY `Bot`, koppelt mention-/allowlist-gating, mediownload via `getFile`/`download`, en levert antwoorden met `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Ondersteunt long-poll of webhook via `webhookCallback`.
- **Proxy:** optionele `channels.telegram.proxy` gebruikt `undici.ProxyAgent` via grammY’s `client.baseFetch`.
- **Webhook-ondersteuning:** `webhook-set.ts` wikkelt `setWebhook/deleteWebhook`; `webhook.ts` host de callback met healthchecks + graceful shutdown. De Gateway schakelt webhook-modus in wanneer `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` zijn ingesteld (anders wordt long-poll gebruikt).
- **Sessies:** directe chats worden samengevoegd tot de hoofd­sessie van de agent (`agent:<agentId>:<mainKey>`); groepen gebruiken `agent:<agentId>:telegram:group:<chatId>`; antwoorden worden teruggerouteerd naar hetzelfde kanaal.
- **Configuratieknoppen:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention-standaarden), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Conceptstreaming:** optionele `channels.telegram.streamMode` gebruikt `sendMessageDraft` in privé-topicchats (Bot API 9.3+). Dit staat los van kanaal-blokstreaming.
- **Tests:** grammY-mocks dekken DM- en groeps-mention-gating en uitgaand verzenden; meer media-/webhook-fixtures zijn nog welkom.

Openstaande vragen

- Optionele grammY-plugins (throttler) toevoegen als we Bot API 429’s tegenkomen.
- Meer gestructureerde mediatests toevoegen (stickers, spraaknotities).
- De webhook-luisterpoort configureerbaar maken (momenteel vast op 8787, tenzij via de Gateway aangesloten).
