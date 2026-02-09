---
summary: "Gateway-singletonbeskyttelse ved brug af WebSocket-lytterbinding"
read_when:
  - Kørsel eller fejlsøgning af gateway-processen
  - Undersøgelse af håndhævelse af enkeltinstans
title: "Gateway-lås"
---

# Gateway-lås

Senest opdateret: 2025-12-11

## Hvorfor

- Sikre, at kun én gateway-instans kører pr. basisport på samme vært; yderligere gateways skal bruge isolerede profiler og unikke porte.
- Overleve nedbrud/SIGKILL uden at efterlade forældede låsefiler.
- Fejle hurtigt med en klar fejl, når kontrolporten allerede er optaget.

## Mekanisme

- Gatewayen binder WebSocket-lytteren (standard `ws://127.0.0.1:18789`) straks ved opstart ved hjælp af en eksklusiv TCP-lytter.
- Hvis bindingen fejler med `EADDRINUSE`, kaster opstarten `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Operativsystemet frigiver automatisk lytteren ved enhver procesafslutning, inklusive nedbrud og SIGKILL—ingen separat låsefil eller oprydningstrin er nødvendig.
- Ved nedlukning lukker gatewayen WebSocket-serveren og den underliggende HTTP-server for hurtigt at frigive porten.

## Fejlflade

- Hvis en anden proces holder porten, kaster opstarten `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Andre bindingfejl vises som `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Driftsnoter

- Hvis porten er optaget af en _anden_ proces, er fejlen den samme; frigiv porten eller vælg en anden med `openclaw gateway --port <port>`.
- macOS-appen opretholder stadig sin egen letvægts-PID-beskyttelse, før gatewayen startes; runtime-låsen håndhæves af WebSocket-bindingen.
