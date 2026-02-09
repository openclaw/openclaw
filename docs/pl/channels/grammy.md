---
summary: "Integracja z Telegram Bot API za pośrednictwem grammY wraz z uwagami dotyczącymi konfiguracji"
read_when:
  - Praca nad ścieżkami Telegram lub grammY
title: grammY
---

# Integracja grammY (Telegram Bot API)

# Dlaczego grammY

- Klient Bot API zorientowany na TypeScript, z wbudowaną obsługą long-pollingu i webhooków, middleware, obsługą błędów oraz ogranicznikiem szybkości.
- Czytelniejsze pomocniki do mediów niż ręczne użycie fetch + FormData; obsługuje wszystkie metody Bot API.
- Rozszerzalny: obsługa proxy przez niestandardowy fetch, middleware sesji (opcjonalne), kontekst typowany.

# Co dostarczyliśmy

- **Pojedyncza ścieżka klienta:** usunięto implementację opartą na fetch; grammY jest teraz jedynym klientem Telegrama (wysyłanie + gateway) z domyślnie włączonym ogranicznikiem grammY.
- **Gateway:** `monitorTelegramProvider` tworzy grammY `Bot`, podłącza bramkowanie wzmianek/listy dozwolonych, pobieranie mediów przez `getFile`/`download` oraz dostarcza odpowiedzi z użyciem `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Obsługuje long-polling lub webhook przez `webhookCallback`.
- **Proxy:** opcjonalny `channels.telegram.proxy` używa `undici.ProxyAgent` poprzez `client.baseFetch` w grammY.
- **Obsługa webhooków:** `webhook-set.ts` opakowuje `setWebhook/deleteWebhook`; `webhook.ts` hostuje callback z kontrolą zdrowia i łagodnym zamykaniem. Gateway włącza tryb webhook, gdy ustawione są `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (w przeciwnym razie używa long-pollingu).
- **Sesje:** czaty bezpośrednie są scalane do głównej sesji agenta (`agent:<agentId>:<mainKey>`); grupy używają `agent:<agentId>:telegram:group:<chatId>`; odpowiedzi wracają do tego samego kanału.
- **Pokrętła konfiguracyjne:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (domyślne ustawienia listy dozwolonych + wzmianek), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Strumieniowanie wersji roboczej:** opcjonalny `channels.telegram.streamMode` używa `sendMessageDraft` w prywatnych czatach z tematami (Bot API 9.3+). Jest to niezależne od strumieniowania blokowego kanału.
- **Testy:** mocki grammY obejmują bramkowanie DM-ów + wzmianek w grupach oraz wysyłanie wychodzące; mile widziane są kolejne fixtury dla mediów/webhooków.

Otwarte pytania

- Opcjonalne wtyczki grammY (ogranicznik) w przypadku napotkania 429 z Bot API.
- Dodanie bardziej ustrukturyzowanych testów mediów (naklejki, notatki głosowe).
- Umożliwienie konfiguracji portu nasłuchu webhooka (obecnie na sztywno 8787, o ile nie jest poprowadzony przez gateway).
