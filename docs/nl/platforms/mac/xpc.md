---
summary: "macOS IPC-architectuur voor de OpenClaw-app, Gateway-node-transport en PeekabooBridge"
read_when:
  - Bewerken van IPC-contracten of IPC van de menubalk-app
title: "macOS IPC"
---

# OpenClaw macOS IPC-architectuur

**Huidig model:** een lokale Unix-socket verbindt de **node-hostservice** met de **macOS-app** voor uitvoeringsgoedkeuringen + `system.run`. Er bestaat een `openclaw-mac` debug-CLI voor discovery-/connect-controles; agentacties lopen nog steeds via de Gateway WebSocket en `node.invoke`. UI-automatisering gebruikt PeekabooBridge.

## Doelen

- Eén enkele GUI-app-instantie die al het TCC-gerelateerde werk beheert (meldingen, schermopname, microfoon, spraak, AppleScript).
- Een klein oppervlak voor automatisering: Gateway + node-opdrachten, plus PeekabooBridge voor UI-automatisering.
- Voorspelbare rechten: altijd dezelfde gesigneerde bundle-ID, gestart door launchd, zodat TCC-toestemmingen behouden blijven.

## Hoe het werkt

### Gateway + node-transport

- De app draait de Gateway (lokale modus) en verbindt ermee als een node.
- Agentacties worden uitgevoerd via `node.invoke` (bijv. `system.run`, `system.notify`, `canvas.*`).

### Node-service + app IPC

- Een headless node-hostservice verbindt met de Gateway WebSocket.
- `system.run`-verzoeken worden doorgestuurd naar de macOS-app via een lokale Unix-socket.
- De app voert de actie uit in UI-context, vraagt indien nodig om bevestiging en retourneert de uitvoer.

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI-automatisering)

- UI-automatisering gebruikt een aparte UNIX-socket met de naam `bridge.sock` en het PeekabooBridge-JSON-protocol.
- Voorkeursvolgorde van hosts (client-side): Peekaboo.app → Claude.app → OpenClaw.app → lokale uitvoering.
- Beveiliging: bridge-hosts vereisen een toegestane TeamID; een DEBUG-only same-UID escape hatch wordt bewaakt door `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo-conventie).
- Zie: [PeekabooBridge usage](/platforms/mac/peekaboo) voor details.

## Operationele stromen

- Herstarten/herbouwen: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Doodt bestaande instanties
  - Swift-build + packaging
  - Schrijft/bootstrappt/kickstart de LaunchAgent
- Enkele instantie: de app sluit vroegtijdig af als er al een andere instantie met dezelfde bundle-ID draait.

## Hardening-notities

- Geef de voorkeur aan het vereisen van een TeamID-overeenkomst voor alle geprivilegieerde oppervlakken.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (alleen DEBUG) kan same-UID-aanroepers toestaan voor lokale ontwikkeling.
- Alle communicatie blijft uitsluitend lokaal; er worden geen netwerksockets blootgesteld.
- TCC-prompts zijn uitsluitend afkomstig van de GUI-app-bundle; houd de gesigneerde bundle-ID stabiel tussen herbuilds.
- IPC-hardening: socketmodus `0600`, token, peer-UID-controles, HMAC challenge/response, korte TTL.
