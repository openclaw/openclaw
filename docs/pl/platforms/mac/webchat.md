---
summary: "Jak aplikacja na macOS osadza WebChat Gateway i jak go debugować"
read_when:
  - Debugowanie widoku WebChat na macOS lub portu loopback
title: "WebChat"
---

# WebChat (aplikacja macOS)

Aplikacja na macOS w pasku menu osadza interfejs WebChat jako natywny widok SwiftUI. Łączy się z Gateway i domyślnie używa **sesji głównej** dla wybranego agenta (z przełącznikiem sesji dla innych sesji).

- **Tryb lokalny**: łączy się bezpośrednio z lokalnym WebSocketem Gateway.
- **Tryb zdalny**: przekazuje port kontrolny Gateway przez SSH i używa tego
  tunelu jako płaszczyzny danych.

## Uruchamianie i debugowanie

- Ręcznie: menu Lobster → „Open Chat”.

- Automatyczne otwieranie do testów:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logi: `./scripts/clawlog.sh` (podsystem `bot.molt`, kategoria `WebChatSwiftUI`).

## Jak to jest połączone

- Płaszczyzna danych: metody WS Gateway `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` oraz zdarzenia `chat`, `agent`, `presence`, `tick`, `health`.
- Sesja: domyślnie główna sesja (`main` lub `global`, gdy zakres jest
  globalny). Interfejs użytkownika umożliwia przełączanie między sesjami.
- Onboarding używa dedykowanej sesji, aby zachować konfigurację pierwszego uruchomienia oddzielnie.

## Powierzchnia bezpieczeństwa

- Tryb zdalny przekazuje przez SSH wyłącznie port kontrolny WebSocket Gateway.

## Znane ograniczenia

- Interfejs użytkownika jest zoptymalizowany pod sesje czatu (nie jest to pełny sandbox przeglądarki).
