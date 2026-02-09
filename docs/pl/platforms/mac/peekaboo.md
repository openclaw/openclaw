---
summary: "„Integracja PeekabooBridge do automatyzacji interfejsu użytkownika w macOS”"
read_when:
  - Hostowanie PeekabooBridge w OpenClaw.app
  - Integracja Peekaboo za pomocą Swift Package Manager
  - Zmiana protokołu/ścieżek PeekabooBridge
title: "„Peekaboo Bridge”"
---

# Peekaboo Bridge (automatyzacja UI w macOS)

OpenClaw może hostować **PeekabooBridge** jako lokalny, świadomy uprawnień broker
automatyzacji UI. Umożliwia to sterowanie automatyzacją UI przez CLI `peekaboo`,
przy jednoczesnym ponownym wykorzystaniu uprawnień TCC aplikacji macOS.

## Czym to jest (a czym nie)

- **Host**: OpenClaw.app może działać jako host PeekabooBridge.
- **Klient**: użyj CLI `peekaboo` (bez osobnej powierzchni `openclaw ui ...`).
- **UI**: wizualne nakładki pozostają w Peekaboo.app; OpenClaw jest cienkim hostem brokera.

## Włączanie mostu

W aplikacji macOS:

- Ustawienia → **Włącz Peekaboo Bridge**

Po włączeniu OpenClaw uruchamia lokalny serwer gniazda UNIX. Po wyłączeniu host
zostaje zatrzymany, a `peekaboo` wróci do innych dostępnych hostów.

## Kolejność wykrywania klienta

Klienci Peekaboo zazwyczaj próbują hostów w tej kolejności:

1. Peekaboo.app (pełne UX)
2. Claude.app (jeśli zainstalowana)
3. OpenClaw.app (cienki broker)

Użyj `peekaboo bridge status --verbose`, aby sprawdzić, który host jest aktywny i jaka
ścieżka gniazda jest używana. Możesz nadpisać to ustawienie poleceniem:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Bezpieczeństwo i uprawnienia

- Most weryfikuje **podpisy kodu wywołującego**; egzekwowana jest lista dozwolonych TeamID
  (TeamID hosta Peekaboo + TeamID aplikacji OpenClaw).
- Żądania wygasają po ~10 sekundach.
- Jeśli brakuje wymaganych uprawnień, most zwraca czytelny komunikat błędu,
  zamiast uruchamiać Ustawienia systemowe.

## Zachowanie migawek (automatyzacja)

Migawki są przechowywane w pamięci i automatycznie wygasają po krótkim czasie.
Jeśli potrzebna jest dłuższa retencja, wykonaj ponowne przechwycenie po stronie klienta.

## Rozwiązywanie problemów

- Jeśli `peekaboo` zgłasza „bridge client is not authorized”, upewnij się, że klient
  jest poprawnie podpisany lub uruchom hosta z `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  wyłącznie w trybie **debug**.
- Jeśli nie znaleziono żadnych hostów, otwórz jedną z aplikacji hosta (Peekaboo.app lub OpenClaw.app)
  i potwierdź, że uprawnienia zostały przyznane.
