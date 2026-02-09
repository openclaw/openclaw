---
summary: "Jak wpisy obecności OpenClaw są tworzone, scalane i wyświetlane"
read_when:
  - Debugowanie karty Instances
  - Badanie zduplikowanych lub nieaktualnych wierszy instancji
  - Zmienianie połączeń WS Gateway lub sygnałów systemowych
title: "Obecność"
---

# Obecność

„Obecność” OpenClaw to lekki, działający w trybie best‑effort widok:

- samego **Gateway**, oraz
- **klientów połączonych z Gateway** (aplikacja na macOS, WebChat, CLI itp.)

Obecność jest używana głównie do renderowania karty **Instances** w aplikacji na macOS
oraz do zapewnienia operatorom szybkiej widoczności.

## Pola obecności (co się wyświetla)

Wpisy obecności są obiektami o ustrukturyzowanych polach, takich jak:

- `instanceId` (opcjonalne, ale zdecydowanie zalecane): stabilna tożsamość klienta (zwykle `connect.client.instanceId`)
- `host`: przyjazna dla użytkownika nazwa hosta
- `ip`: adres IP w trybie best‑effort
- `version`: ciąg wersji klienta
- `deviceFamily` / `modelIdentifier`: wskazówki sprzętowe
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: „sekundy od ostatniego wejścia użytkownika” (jeśli znane)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: znacznik czasu ostatniej aktualizacji (ms od epoki)

## Producenci (skąd pochodzi obecność)

Wpisy obecności są generowane przez wiele źródeł i **scalane**.

### 1. Wpis własny Gateway

Gateway zawsze inicjuje wpis „self” przy uruchomieniu, aby interfejsy użytkownika
pokazywały host Gateway nawet zanim połączą się jakiekolwiek klienci.

### 2. Połączenie WebSocket

Każdy klient WS zaczyna od żądania `connect`. Po pomyślnym uściśnięciu dłoni
Gateway wykonuje upsert wpisu obecności dla tego połączenia.

#### Dlaczego jednorazowe polecenia CLI się nie wyświetlają

CLI często łączy się na krótkie, jednorazowe polecenia. Aby uniknąć zaśmiecania listy
Instances, `client.mode === "cli"` **nie** jest zamieniane na wpis obecności.

### 3. Sygnały (beacons) `system-event`

Klienci mogą wysyłać bogatsze, okresowe sygnały przez metodę `system-event`. Aplikacja
na macOS używa tego do raportowania nazwy hosta, adresu IP oraz `lastInputSeconds`.

### 4. Połączenia węzłów (rola: node)

Gdy węzeł łączy się przez WebSocket Gateway z `role: node`, Gateway wykonuje upsert
wpisu obecności dla tego węzła (ten sam przepływ co dla innych klientów WS).

## Zasady scalania i deduplikacji (dlaczego `instanceId` ma znaczenie)

Wpisy obecności są przechowywane w jednej mapie w pamięci:

- Wpisy są kluczowane przez **klucz obecności**.
- Najlepszym kluczem jest stabilny `instanceId` (z `connect.client.instanceId`), który przetrwa restarty.
- Klucze nie rozróżniają wielkości liter.

Jeśli klient połączy się ponownie bez stabilnego `instanceId`, może pojawić się
jako **zduplikowany** wiersz.

## TTL i ograniczony rozmiar

Obecność jest celowo efemeryczna:

- **TTL:** wpisy starsze niż 5 minut są usuwane
- **Maks. liczba wpisów:** 200 (najstarsze są usuwane jako pierwsze)

Dzięki temu lista pozostaje świeża i unika nieograniczonego wzrostu zużycia pamięci.

## Zdalny / tunel (adresy IP loopback)

Gdy klient łączy się przez tunel SSH / lokalne przekierowanie portów, Gateway może
widzieć adres zdalny jako `127.0.0.1`. Aby nie nadpisywać poprawnego adresu IP
zgłoszonego przez klienta, zdalne adresy loopback są ignorowane.

## Konsumenci

### Karta Instances w macOS

Aplikacja na macOS renderuje wynik `system-presence` i stosuje niewielki wskaźnik stanu
(Aktywny/Bezczynny/Nieaktualny) na podstawie wieku ostatniej aktualizacji.

## Wskazówki debugowania

- Aby zobaczyć surową listę, wywołaj `system-presence` względem Gateway.
- Jeśli widzisz duplikaty:
  - potwierdź, że klienci wysyłają stabilny `client.instanceId` podczas uściśnięcia dłoni
  - potwierdź, że okresowe sygnały używają tego samego `instanceId`
  - sprawdź, czy wpis pochodzący z połączenia nie ma `instanceId` (duplikaty są wówczas oczekiwane)
