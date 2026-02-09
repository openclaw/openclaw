---
summary: "„Integration der Telegram Bot API über grammY mit Hinweisen zur Einrichtung“"
read_when:
  - Arbeiten an Telegram- oder grammY-Pfaden
title: grammY
---

# grammY-Integration (Telegram Bot API)

# Warum grammY

- TS-first Bot-API-Client mit integrierten Long-Poll- und Webhook-Helfern, Middleware, Fehlerbehandlung und Rate-Limiter.
- Sauberere Media-Helfer als selbstgebautes fetch + FormData; unterstützt alle Bot-API-Methoden.
- Erweiterbar: Proxy-Unterstützung über benutzerdefiniertes fetch, Sitzungs-Middleware (optional), typsicherer Kontext.

# Was wir ausgeliefert haben

- **Einzelner Client-Pfad:** Fetch-basierte Implementierung entfernt; grammY ist jetzt der einzige Telegram-Client (Senden + Gateway) mit standardmäßig aktiviertem grammY-Throttler.
- **Gateway:** `monitorTelegramProvider` erstellt ein grammY `Bot`, verdrahtet Mention-/Allowlist-Gating, Medien-Download über `getFile`/`download` und liefert Antworten mit `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Unterstützt Long-Poll oder Webhook über `webhookCallback`.
- **Proxy:** Optionales `channels.telegram.proxy` nutzt `undici.ProxyAgent` über grammYs `client.baseFetch`.
- **Webhook-Unterstützung:** `webhook-set.ts` kapselt `setWebhook/deleteWebhook`; `webhook.ts` hostet den Callback mit Health-Check + Graceful Shutdown. Das Gateway aktiviert den Webhook-Modus, wenn `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` gesetzt sind (ansonsten wird Long-Polling verwendet).
- **Sitzungen:** Direktchats werden in die Hauptsitzung des Agenten zusammengeführt (`agent:<agentId>:<mainKey>`); Gruppen verwenden `agent:<agentId>:telegram:group:<chatId>`; Antworten werden in denselben Kanal zurückgeleitet.
- **Konfigurationsoptionen:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (Allowlist- + Mention-Defaults), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Draft-Streaming:** Optionales `channels.telegram.streamMode` nutzt `sendMessageDraft` in privaten Topic-Chats (Bot API 9.3+). Dies ist getrennt vom Channel-Block-Streaming.
- **Tests:** grammY-Mocks decken Direktnachrichten + Gruppen-Mention-Gating sowie ausgehendes Senden ab; weitere Media-/Webhook-Fixtures sind weiterhin willkommen.

Offene Fragen

- Optionale grammY-Plugins (Throttler), falls wir Bot-API-429s erreichen.
- Weitere strukturierte Media-Tests hinzufügen (Sticker, Sprachnotizen).
- Webhook-Listen-Port konfigurierbar machen (derzeit fest auf 8787, sofern nicht über das Gateway verdrahtet).
