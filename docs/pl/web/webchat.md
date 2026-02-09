---
summary: "Statyczny host WebChat w pętli zwrotnej oraz użycie Gateway WS dla interfejsu czatu"
read_when:
  - Debugowanie lub konfigurowanie dostępu do WebChat
title: "WebChat"
---

# WebChat (interfejs WebSocket Gateway)

Status: interfejs czatu SwiftUI na macOS/iOS komunikuje się bezpośrednio z WebSocket Gateway.

## Czym to jest

- Natywny interfejs czatu dla gateway (bez osadzonej przeglądarki i bez lokalnego serwera statycznego).
- Używa tych samych sesji i reguł routingu co inne kanały.
- Deterministyczny routing: odpowiedzi zawsze wracają do WebChat.

## Szybki start

1. Uruchom gateway.
2. Otwórz interfejs WebChat (aplikacja macOS/iOS) lub kartę czatu w interfejsie Control UI.
3. Upewnij się, że uwierzytelnianie gateway jest skonfigurowane (wymagane domyślnie, nawet na local loopback).

## Jak to działa (zachowanie)

- Interfejs łączy się z WebSocket Gateway i używa `chat.history`, `chat.send` oraz `chat.inject`.
- `chat.inject` dołącza notatkę asystenta bezpośrednio do transkryptu i rozgłasza ją do interfejsu (bez uruchamiania agenta).
- Historia jest zawsze pobierana z gateway (bez lokalnego obserwowania plików).
- Jeśli gateway jest nieosiągalny, WebChat działa tylko do odczytu.

## Użycie zdalne

- Tryb zdalny tuneluje WebSocket gateway przez SSH/Tailscale.
- Nie musisz uruchamiać osobnego serwera WebChat.

## Referencja konfiguracji (WebChat)

Pełna konfiguracja: [Konfiguracja](/gateway/configuration)

Opcje kanału:

- Brak dedykowanego bloku `webchat.*`. WebChat używa punktu końcowego gateway oraz poniższych ustawień uwierzytelniania.

Powiązane opcje globalne:

- `gateway.port`, `gateway.bind`: host/port WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: uwierzytelnianie WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: docelowy gateway zdalny.
- `session.*`: magazyn sesji oraz domyślne klucze główne.
