---
summary: "macOS IPC-arkitektur for OpenClaw-appen, gateway-node-transport og PeekabooBridge"
read_when:
  - Redigering af IPC-kontrakter eller menulinje-appens IPC
title: "macOS IPC"
---

# OpenClaw macOS IPC-arkitektur

**Aktuelt** en lokal Unix socket forbinder **node host service** til **macOS appen** for exec godkendelser + `system.run`. En `openclaw-mac` debug CLI findes til opdagelse/forbindelseskontrol; agent handlinger stadig flyder gennem Gateway WebSocket og `node.invoke`. UI automation bruger PeekabooBridge.

## Mål

- Én enkelt GUI-appinstans, der ejer alt TCC-relateret arbejde (notifikationer, skærmoptagelse, mikrofon, tale, AppleScript).
- En lille automationsflade: Gateway + node-kommandoer samt PeekabooBridge til UI-automatisering.
- Forudsigelige tilladelser: altid samme signerede bundle ID, startet af launchd, så TCC-tilladelser fastholdes.

## Sådan virker det

### Gateway + node-transport

- Appen kører Gateway (lokal tilstand) og forbinder til den som en node.
- Agent handlinger udføres via `node.invoke` (f.eks. `system.run`, `system.notify`, `canvas.*`).

### Node-tjeneste + app IPC

- En headless node-værtstjeneste forbinder til Gateway WebSocket.
- `system.run`-anmodninger videresendes til macOS-appen over en lokal Unix-socket.
- Appen udfører exec i UI-kontekst, viser prompt om nødvendigt og returnerer output.

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI-automatisering)

- UI-automatisering bruger en separat UNIX-socket med navnet `bridge.sock` og PeekabooBridge JSON-protokollen.
- Værtspræferenceorden (klientside): Peekaboo.app → Claude.app → OpenClaw.app → lokal eksekvering.
- Sikkerhed: bridge-værter kræver en tilladt TeamID; DEBUG-only samme-UID undtagelse er beskyttet af `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo-konvention).
- Se: [PeekabooBridge usage](/platforms/mac/peekaboo) for detaljer.

## Driftsflows

- Genstart/genopbygning: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Afslutter eksisterende instanser
  - Swift build + pakning
  - Skriver/bootstrapper/kickstarter LaunchAgent
- Enkelt instans: appen afslutter tidligt, hvis en anden instans med samme bundle ID kører.

## Hærdningsnoter

- Foretræk at kræve TeamID-match for alle privilegerede flader.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (kun DEBUG) kan tillade same-UID-kaldere til lokal udvikling.
- Al kommunikation forbliver lokal; ingen netværkssockets eksponeres.
- TCC-prompter stammer kun fra GUI-appens bundle; hold det signerede bundle ID stabilt på tværs af genopbygninger.
- IPC-hærdning: socket-tilstand `0600`, token, peer-UID-tjek, HMAC challenge/response, kort TTL.
