---
summary: "Ochrona pojedynczej instancji Gateway przy użyciu wiązania nasłuchu WebSocket"
read_when:
  - Uruchamianie lub debugowanie procesu Gateway
  - Badanie wymuszania pojedynczej instancji
title: "Blokada Gateway"
---

# Blokada Gateway

Ostatnia aktualizacja: 2025-12-11

## Dlaczego

- Zapewnienie, że na tym samym hoście działa tylko jedna instancja gateway na dany port bazowy; dodatkowe gateway muszą używać odizolowanych profili i unikatowych portów.
- Odporność na awarie/SIGKILL bez pozostawiania przestarzałych plików blokady.
- Szybkie zakończenie z czytelnym błędem, gdy port sterujący jest już zajęty.

## Mechanizm

- Gateway wiąże nasłuch WebSocket (domyślnie `ws://127.0.0.1:18789`) natychmiast przy starcie, używając wyłącznego nasłuchu TCP.
- Jeśli wiązanie się nie powiedzie z `EADDRINUSE`, uruchamianie zgłasza `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- System operacyjny automatycznie zwalnia nasłuch przy każdym zakończeniu procesu, w tym przy awariach i SIGKILL — nie jest potrzebny osobny plik blokady ani krok sprzątania.
- Podczas zamykania Gateway zamyka serwer WebSocket oraz bazowy serwer HTTP, aby niezwłocznie zwolnić port.

## Powierzchnia błędów

- Jeśli inny proces zajmuje port, uruchamianie zgłasza `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Inne błędy wiązania są raportowane jako `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Uwagi operacyjne

- Jeśli port jest zajęty przez _inny_ proces, błąd jest taki sam; zwolnij port lub wybierz inny za pomocą `openclaw gateway --port <port>`.
- Aplikacja na macOS nadal utrzymuje własną lekką blokadę PID przed uruchomieniem Gateway; blokada czasu wykonania jest wymuszana przez wiązanie WebSocket.
