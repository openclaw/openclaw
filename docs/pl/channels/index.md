---
summary: "Platformy komunikacyjne, z którymi OpenClaw może się łączyć"
read_when:
  - Chcesz wybrać kanał czatu dla OpenClaw
  - Potrzebujesz szybkiego przeglądu obsługiwanych platform komunikacyjnych
title: "Kanały czatu"
---

# Kanały czatu

OpenClaw może komunikować się z Tobą w dowolnej aplikacji czatu, z której już korzystasz. Każdy kanał łączy się przez Gateway.
Tekst jest obsługiwany wszędzie; obsługa multimediów i reakcji różni się w zależności od kanału.

## Obsługiwane kanały

- [WhatsApp](/channels/whatsapp) — Najpopularniejszy; używa Baileys i wymaga parowania QR.
- [Telegram](/channels/telegram) — Bot API przez grammY; obsługuje grupy.
- [Discord](/channels/discord) — Discord Bot API + Gateway; obsługuje serwery, kanały i DM-y.
- [Slack](/channels/slack) — SDK Bolt; aplikacje obszaru roboczego.
- [Feishu](/channels/feishu) — Bot Feishu/Lark przez WebSocket (wtyczka, instalowana osobno).
- [Google Chat](/channels/googlechat) — Aplikacja Google Chat API przez webhook HTTP.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kanały, grupy, DM-y (wtyczka, instalowana osobno).
- [Signal](/channels/signal) — signal-cli; nastawiony na prywatność.
- [BlueBubbles](/channels/bluebubbles) — **Zalecane dla iMessage**; używa REST API serwera BlueBubbles na macOS z pełną obsługą funkcji (edycja, cofanie wysyłania, efekty, reakcje, zarządzanie grupami — edycja jest obecnie zepsuta w macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Starsza integracja z macOS przez CLI imsg (wycofywana; do nowych instalacji użyj BlueBubbles).
- [Microsoft Teams](/channels/msteams) — Bot Framework; wsparcie dla środowisk korporacyjnych (wtyczka, instalowana osobno).
- [LINE](/channels/line) — Bot LINE Messaging API (wtyczka, instalowana osobno).
- [Nextcloud Talk](/channels/nextcloud-talk) — Samohostowany czat przez Nextcloud Talk (wtyczka, instalowana osobno).
- [Matrix](/channels/matrix) — Protokół Matrix (wtyczka, instalowana osobno).
- [Nostr](/channels/nostr) — Zdecentralizowane DM-y przez NIP-04 (wtyczka, instalowana osobno).
- [Tlon](/channels/tlon) — Komunikator oparty na Urbit (wtyczka, instalowana osobno).
- [Twitch](/channels/twitch) — Czat Twitch przez połączenie IRC (wtyczka, instalowana osobno).
- [Zalo](/channels/zalo) — Bot Zalo Bot API; popularny komunikator w Wietnamie (wtyczka, instalowana osobno).
- [Zalo Personal](/channels/zalouser) — Konto osobiste Zalo przez logowanie QR (wtyczka, instalowana osobno).
- [WebChat](/web/webchat) — Interfejs WebChat Gateway przez WebSocket.

## Uwagi

- Kanały mogą działać jednocześnie; skonfiguruj wiele, a OpenClaw będzie routować komunikację per czat.
- Najszybsza konfiguracja to zwykle **Telegram** (prosty token bota). WhatsApp wymaga parowania QR i
  przechowuje więcej stanu na dysku.
- Zachowanie w grupach różni się w zależności od kanału; zobacz [Grupy](/channels/groups).
- Parowanie DM-ów i listy dozwolonych są wymuszane ze względów bezpieczeństwa; zobacz [Bezpieczeństwo](/gateway/security).
- Wewnętrzne szczegóły Telegrama: [uwagi grammY](/channels/grammy).
- Rozwiązywanie problemów: [Rozwiązywanie problemów z kanałami](/channels/troubleshooting).
- Dostawcy modeli są udokumentowani osobno; zobacz [Dostawcy modeli](/providers/models).
