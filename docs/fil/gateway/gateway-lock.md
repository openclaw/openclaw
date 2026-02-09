---
summary: "Singleton guard ng Gateway gamit ang pag-bind ng WebSocket listener"
read_when:
  - Kapag nagpapatakbo o nagde-debug ng proseso ng gateway
  - Kapag iniimbestigahan ang pagpapatupad ng single-instance
title: "Gateway Lock"
---

# Lock ng Gateway

Huling na-update: 2025-12-11

## Bakit

- Tiyakin na iisa lang ang instance ng gateway na tumatakbo kada base port sa parehong host; ang mga karagdagang gateway ay dapat gumamit ng hiwalay na profiles at natatanging mga port.
- Makaligtas sa mga crash/SIGKILL nang hindi nag-iiwan ng mga lipas na lock file.
- Mabilis na mag-fail na may malinaw na error kapag okupado na ang control port.

## Mekanismo

- Agad na bino-bind ng gateway ang WebSocket listener (default `ws://127.0.0.1:18789`) sa pagsisimula gamit ang isang eksklusibong TCP listener.
- Kapag nabigo ang bind na may `EADDRINUSE`, ang startup ay magtatapon ng `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Awtomatikong nire-release ng OS ang listener sa anumang pag-exit ng proseso, kabilang ang mga crash at SIGKILL—walang hiwalay na lock file o hakbang sa cleanup ang kailangan.
- Sa pag-shutdown, isinasara ng gateway ang WebSocket server at ang underlying HTTP server upang agad na mapalaya ang port.

## Error surface

- Kung may ibang prosesong may hawak ng port, ang startup ay magtatapon ng `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Ang iba pang mga failure sa bind ay lalabas bilang `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Mga tala sa operasyon

- Kung ang port ay okupado ng _ibang_ proseso, pareho ang error; palayain ang port o pumili ng iba gamit ang `openclaw gateway --port <port>`.
- Ang macOS app ay nagpapanatili pa rin ng sarili nitong magaan na PID guard bago i-spawn ang gateway; ang runtime lock ay ipinapatupad ng WebSocket bind.
