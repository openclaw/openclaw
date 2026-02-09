---
summary: "Gateway-singletonbeveiliging via de WebSocket-listenerbinding"
read_when:
  - Het gatewayproces uitvoeren of debuggen
  - Onderzoeken van handhaving van één instantie
title: "Gateway-vergrendeling"
---

# Gateway-vergrendeling

Laatst bijgewerkt: 2025-12-11

## Waarom

- Zorgen dat er per basispoort op dezelfde host slechts één Gateway-instantie draait; extra Gateways moeten geïsoleerde profielen en unieke poorten gebruiken.
- Crashes/SIGKILL overleven zonder verouderde lockbestanden achter te laten.
- Snel falen met een duidelijke foutmelding wanneer de control-poort al bezet is.

## Mechanisme

- De Gateway bindt de WebSocket-listener (standaard `ws://127.0.0.1:18789`) onmiddellijk bij het opstarten met een exclusieve TCP-listener.
- Als de binding mislukt met `EADDRINUSE`, gooit de opstartfase `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Het besturingssysteem geeft de listener automatisch vrij bij elke procesafsluiting, inclusief crashes en SIGKILL—er is geen apart lockbestand of opschoonstap nodig.
- Bij afsluiten sluit de Gateway de WebSocket-server en de onderliggende HTTP-server om de poort snel vrij te maken.

## Foutoppervlak

- Als een ander proces de poort bezet houdt, gooit de opstartfase `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Andere bindfouten verschijnen als `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Operationele notities

- Als de poort bezet is door een _ander_ proces, is de fout hetzelfde; maak de poort vrij of kies een andere met `openclaw gateway --port <port>`.
- De macOS-app hanteert nog steeds een eigen lichtgewicht PID-beveiliging voordat de Gateway wordt gestart; de runtimevergrendeling wordt afgedwongen door de WebSocket-binding.
