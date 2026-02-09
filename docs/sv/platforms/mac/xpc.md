---
summary: "”macOS IPC-arkitektur för OpenClaw-appen, gateway-nodtransport och PeekabooBridge”"
read_when:
  - Redigering av IPC-kontrakt eller menyradsappens IPC
title: "”macOS IPC”"
---

# OpenClaw macOS IPC-arkitektur

**Nuvarande modell:** en lokal Unix-uttag ansluter **nod värdtjänst** till **macOS app** för exec godkännanden + `system.run`. En `openclaw-mac` debug CLI finns för upptäckt/anslut kontroller; agentåtgärder flödar fortfarande genom Gateway WebSocket och `node.invoke`. UI automation använder PeekabooBridge.

## Mål

- En enda GUI-appinstans som äger allt TCC-relaterat arbete (notiser, skärminspelning, mikrofon, tal, AppleScript).
- En liten yta för automation: Gateway (nätverksgateway) + nodkommandon, samt PeekabooBridge för UI-automation.
- Förutsägbara behörigheter: alltid samma signerade bundle-ID, startad av launchd, så att TCC-behörigheter består.

## Hur det fungerar

### Gateway (nätverksgateway) + nodtransport

- Appen kör Gateway (nätverksgateway) (lokalt läge) och ansluter till den som en nod.
- Agentåtgärder utförs via `node.invoke` (t.ex. `system.run`, `system.notify`, `canvas.*`).

### Nodtjänst + app-IPC

- En headless nodvärdtjänst ansluter till Gateway (nätverksgateway) WebSocket.
- `system.run`-förfrågningar vidarebefordras till macOS-appen över en lokal Unix-socket.
- Appen utför exec i UI-kontext, visar promptar vid behov och returnerar utdata.

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI-automation)

- UI-automation använder en separat UNIX-socket med namnet `bridge.sock` och PeekabooBridge JSON-protokollet.
- Värdpreferensordning (klientsida): Peekaboo.app → Claude.app → OpenClaw.app → lokal exekvering.
- Säkerhet: brovärdar kräver ett tillåtet TeamID; DEBUG-endast flyktlucka med samma UID skyddas av `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo-konvention).
- Se: [PeekabooBridge-användning](/platforms/mac/peekaboo) för detaljer.

## Operativa flöden

- Omstart/ombyggnad: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Dödar befintliga instanser
  - Swift-bygg + paketering
  - Skriver/bootstrappar/kickstartar LaunchAgent
- Enstaka instans: appen avslutas tidigt om en annan instans med samma bundle-ID körs.

## Härdningsnoteringar

- Föredra att kräva TeamID-matchning för alla privilegierade ytor.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (endast DEBUG) kan tillåta anropare med samma UID för lokal utveckling.
- All kommunikation förblir enbart lokal; inga nätverkssocklar exponeras.
- TCC-promptar kommer endast från GUI-appens bundle; håll det signerade bundle-ID:t stabilt mellan ombyggnader.
- IPC-härdning: socket-läge `0600`, token, kontroller av peer-UID, HMAC challenge/response, kort TTL.
