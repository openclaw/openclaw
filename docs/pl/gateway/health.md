---
summary: "Etapy oceny stanu dla połączenia z kanałem"
read_when:
  - Diagnozowanie stanu kanału WhatsApp
title: "Kontrole zdrowia"
---

# Kontrole stanu (CLI)

Krótki przewodnik do weryfikacji łączności kanałów bez zgadywania.

## Szybkie kontrole

- `openclaw status` — lokalne podsumowanie: osiągalność/tryb gateway (bramy), wskazówka aktualizacji, wiek uwierzytelnienia połączonego kanału, sesje + ostatnia aktywność.
- `openclaw status --all` — pełna lokalna diagnostyka (tylko do odczytu, kolorowa, bezpieczna do wklejenia przy debugowaniu).
- `openclaw status --deep` — dodatkowo sonduje działającą Gateway (sondy per kanał, gdy są obsługiwane).
- `openclaw health --json` — pyta działającą Gateway o pełny zrzut stanu zdrowia (tylko WS; bez bezpośredniego gniazda Baileys).
- Wyślij `/status` jako samodzielną wiadomość w WhatsApp/WebChat, aby uzyskać odpowiedź o stanie bez wywoływania agenta.
- Logi: tail `/tmp/openclaw/openclaw-*.log` i filtruj pod kątem `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Zaawansowana diagnostyka

- Poświadczenia na dysku: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime powinien być świeży).
- Magazyn sesji: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (ścieżkę można nadpisać w konfiguracji). Liczba i ostatni odbiorcy są prezentowane przez `status`.
- Przepływ ponownego połączenia: `openclaw channels logout && openclaw channels login --verbose` gdy w logach pojawią się kody stanu 409–515 lub `loggedOut`. (Uwaga: przepływ logowania QR automatycznie uruchamia się ponownie raz dla statusu 515 po sparowaniu).

## Gdy coś zawiedzie

- `logged out` lub status 409–515 → ponownie połącz za pomocą `openclaw channels logout`, a następnie `openclaw channels login`.
- Gateway nieosiągalna → uruchom ją: `openclaw gateway --port 18789` (użyj `--force`, jeśli port jest zajęty).
- Brak wiadomości przychodzących → potwierdź, że połączony telefon jest online i nadawca jest dozwolony (`channels.whatsapp.allowFrom`); dla czatów grupowych upewnij się, że lista dozwolonych + reguły wzmianek są zgodne (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedykowane polecenie „health”

`openclaw health --json` pyta działającą Gateway o jej zrzut stanu zdrowia (bez bezpośrednich gniazd kanałów z CLI). Raportuje połączone poświadczenia/wiek uwierzytelnienia (jeśli dostępne), podsumowania sond per kanał, podsumowanie magazynu sesji oraz czas trwania sondy. Zwraca kod wyjścia różny od zera, jeśli Gateway jest nieosiągalna lub sonda zakończy się niepowodzeniem/przekroczeniem czasu. Użyj `--timeout <ms>`, aby nadpisać domyślne 10 s.
