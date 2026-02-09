---
summary: "Jak aplikacja macOS raportuje stany zdrowia gateway/Baileys"
read_when:
  - Debugowanie wskaźników zdrowia aplikacji macOS
title: "Kontrole zdrowia"
---

# Kontrole zdrowia na macOS

Jak sprawdzić, czy połączony kanał jest w dobrej kondycji z poziomu aplikacji w pasku menu.

## Pasek menu

- Kropka statusu odzwierciedla teraz stan zdrowia Baileys:
  - Zielona: połączony + gniazdo otwarte niedawno.
  - Pomarańczowa: łączenie/ponawianie.
  - Czerwona: wylogowany lub nieudana sonda.
- Linia pomocnicza wyświetla „linked · auth 12m” albo pokazuje przyczynę niepowodzenia.
- Pozycja menu „Run Health Check” uruchamia sondę na żądanie.

## Ustawienia

- Karta Ogólne zyskuje kartę Zdrowie, pokazującą: wiek uwierzytelnienia połączenia, ścieżkę/liczbę magazynu sesji, czas ostatniej kontroli, ostatni błąd/kod stanu oraz przyciski Run Health Check / Reveal Logs.
- Wykorzystuje buforowaną migawkę, dzięki czemu interfejs ładuje się natychmiast i łagodnie przechodzi w tryb awaryjny, gdy jest offline.
- **Karta Kanały** prezentuje stan kanałów oraz kontrolki dla WhatsApp/Telegram (QR logowania, wylogowanie, sonda, ostatnie rozłączenie/błąd).

## Jak działa sonda

- Aplikacja uruchamia `openclaw health --json` przez `ShellExecutor` co ~60 s oraz na żądanie. Sonda ładuje poświadczenia i raportuje status bez wysyłania wiadomości.
- Buforuje oddzielnie ostatnią dobrą migawkę oraz ostatni błąd, aby uniknąć migotania; wyświetla znacznik czasu dla każdego z nich.

## W razie wątpliwości

- Nadal możesz użyć przepływu CLI w [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) oraz śledzić `/tmp/openclaw/openclaw-*.log` pod kątem `web-heartbeat` / `web-reconnect`.
