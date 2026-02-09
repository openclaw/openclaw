---
summary: "Gateway-skydd för singleton med bindning av WebSocket-lyssnaren"
read_when:
  - När du kör eller felsöker gateway-processen
  - När du undersöker efterlevnad av eninstanskrav
title: "Gateway-lås"
---

# Gateway-lås

Senast uppdaterad: 2025-12-11

## Varför

- Säkerställa att endast en gateway-instans körs per basport på samma värd; ytterligare gateways måste använda isolerade profiler och unika portar.
- Överleva krascher/SIGKILL utan att lämna kvar inaktuella låsfiler.
- Misslyckas snabbt med ett tydligt fel när kontrollporten redan är upptagen.

## Mekanism

- Gateway (nätverksgateway) binder WebSocket-lyssnaren (standard `ws://127.0.0.1:18789`) omedelbart vid uppstart med en exklusiv TCP-lyssnare.
- Om bindningen misslyckas med `EADDRINUSE` avbryts uppstarten med `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Operativsystemet frigör lyssnaren automatiskt vid alla processavslut, inklusive krascher och SIGKILL—ingen separat låsfil eller städsteg behövs.
- Vid nedstängning stänger gateway WebSocket-servern och den underliggande HTTP-servern för att snabbt frigöra porten.

## Felyta

- Om en annan process håller porten avbryts uppstarten med `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Andra bindningsfel exponeras som `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Driftnoteringar

- Om porten är upptagen av _en annan_ process är felet detsamma; frigör porten eller välj en annan med `openclaw gateway --port <port>`.
- macOS-appen upprätthåller fortfarande sitt eget lättviktiga PID-skydd innan den startar gateway; körningslåset upprätthålls av WebSocket-bindningen.
