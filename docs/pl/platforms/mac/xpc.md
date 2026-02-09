---
summary: "Architektura IPC w macOS dla aplikacji OpenClaw, transportu węzła Gateway oraz PeekabooBridge"
read_when:
  - Edycja kontraktów IPC lub IPC aplikacji paska menu
title: "IPC w macOS"
---

# Architektura IPC OpenClaw w macOS

**Obecny model:** lokalne gniazdo Unix łączy **usługę hosta węzła** z **aplikacją macOS** w celu zatwierdzania exec + `system.run`. Istnieje debugowe CLI `openclaw-mac` do wykrywania/sprawdzania połączeń; działania agentów nadal przepływają przez WebSocket Gateway oraz `node.invoke`. Automatyzacja UI wykorzystuje PeekabooBridge.

## Cele

- Jedna instancja aplikacji GUI, która obsługuje wszystkie działania skierowane do TCC (powiadomienia, nagrywanie ekranu, mikrofon, mowa, AppleScript).
- Mała powierzchnia automatyzacji: Gateway + polecenia węzła oraz PeekabooBridge do automatyzacji UI.
- Przewidywalne uprawnienia: zawsze ten sam podpisany bundle ID, uruchamiany przez launchd, dzięki czemu przyznania TCC są trwałe.

## Jak to działa

### Gateway + transport węzła

- Aplikacja uruchamia Gateway (tryb lokalny) i łączy się z nim jako węzeł.
- Działania agentów są wykonywane przez `node.invoke` (np. `system.run`, `system.notify`, `canvas.*`).

### Usługa węzła + IPC aplikacji

- Bezinterfejsowa usługa hosta węzła łączy się z WebSocket Gateway.
- Żądania `system.run` są przekazywane do aplikacji macOS przez lokalne gniazdo Unix.
- Aplikacja wykonuje exec w kontekście UI, w razie potrzeby wyświetla monit i zwraca wynik.

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (automatyzacja UI)

- Automatyzacja UI używa osobnego gniazda UNIX o nazwie `bridge.sock` oraz protokołu JSON PeekabooBridge.
- Kolejność preferencji hostów (po stronie klienta): Peekaboo.app → Claude.app → OpenClaw.app → wykonanie lokalne.
- Bezpieczeństwo: hosty mostu wymagają dozwolonego TeamID; furtka DEBUG-only dla tego samego UID jest chroniona przez `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (konwencja Peekaboo).
- Zobacz: [Użycie PeekabooBridge](/platforms/mac/peekaboo) po szczegóły.

## Przepływy operacyjne

- Restart/przebudowa: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Zabija istniejące instancje
  - Kompilacja Swift + pakietowanie
  - Zapisywanie/bootstrap/kickstart LaunchAgent
- Pojedyncza instancja: aplikacja kończy się wcześnie, jeśli działa inna instancja z tym samym bundle ID.

## Uwagi dotyczące utwardzania

- Preferuj wymaganie dopasowania TeamID dla wszystkich uprzywilejowanych powierzchni.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) może zezwalać na wywołania z tego samego UID na potrzeby lokalnego rozwoju.
- Cała komunikacja pozostaje wyłącznie lokalna; żadne gniazda sieciowe nie są wystawione.
- Monity TCC pochodzą wyłącznie z pakietu aplikacji GUI; utrzymuj stabilny podpisany bundle ID między przebudowami.
- Utwardzanie IPC: tryb gniazda `0600`, token, sprawdzanie UID rówieśnika, wyzwanie/odpowiedź HMAC, krótki TTL.
