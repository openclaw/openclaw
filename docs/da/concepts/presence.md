---
summary: "Hvordan OpenClaw presence-poster produceres, flettes og vises"
read_when:
  - Fejlfinding af fanen Instances
  - Undersøgelse af dublerede eller forældede instansrækker
  - Ændring af gateway WS-forbindelse eller system-event-beacons
title: "Presence"
---

# Presence

OpenClaw “presence” er et letvægts-, best‑effort-overblik over:

- selve **Gateway**, og
- **klienter, der er forbundet til Gateway** (mac-app, WebChat, CLI osv.)

Presence bruges primært til at gengive macOS-appens **Instances**-fane og til at
give hurtig synlighed for operatører.

## Presence-felter (det, der vises)

Presence-poster er strukturerede objekter med felter som:

- `instanceId` (valgfri, men stærkt anbefalet): stabil klientidentitet (oftest `connect.client.instanceId`)
- `host`: menneskeligt læsbart værtsnavn
- `ip`: best‑effort IP-adresse
- `version`: klientens versionsstreng
- `deviceFamily` / `modelIdentifier`: hardware-hints
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “sekunder siden sidste brugerinput” (hvis kendt)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: tidsstempel for seneste opdatering (ms siden epoch)

## Producenter (hvor presence kommer fra)

Presence-poster produceres af flere kilder og **flettes**.

### 1. Gatewayens egen post

Gateway sår altid en “self”-post ved opstart, så brugerflader viser gateway-værten,
selv før nogen klienter forbinder.

### 2. WebSocket-forbindelse

Hver WS-klient begynder med en `connect` anmodning. På vellykket håndtryk
Gateway upserts en tilstedeværelse post for denne forbindelse.

#### Hvorfor engangs-CLI-kommandoer ikke vises

CLI forbinder ofte til korte, engangskommandoer. For at undgå spamming af
Instanser listen, `client.mode === "cli"` er **ikke** forvandlet til en tilstedeværelse post.

### 3. `system-event`-beacons

Kunderne kan sende rigere periodiske fyr via 'system-event'-metoden. Appen mac
bruger dette til at rapportere værtsnavn, IP og `lastInputSeconds`.

### 4. Node-forbindelser (rolle: node)

Når en node forbinder over Gateway WebSocket med `role: node`, opretter/opdaterer
Gateway en presence-post for den node (samme flow som andre WS-klienter).

## Fletning + deduplikering (hvorfor `instanceId` er vigtigt)

Presence-poster gemmes i ét samlet in-memory map:

- Poster er nøglede med en **presence-nøgle**.
- Den bedste nøgle er en stabil `instanceId` (fra `connect.client.instanceId`), som overlever genstarter.
- Nøgler er ikke-følsomme over for store/små bogstaver.

Hvis en klient genforbinder uden en stabil `instanceId`, kan den dukke op som en
**dublet**-række.

## TTL og begrænset størrelse

Presence er bevidst flygtig:

- **TTL:** poster ældre end 5 minutter beskæres
- **Max indgange:** 200 (ældste droppet først)

Dette holder listen frisk og undgår ubegrænset hukommelsesvækst.

## Fjern-/tunnel-forbehold (loopback IP’er)

Når en klient forbinder over en SSH-tunnel/lokal port fremad, kan Gateway
se fjernadressen som '127.0.0.1'. For at undgå at overskrive en god kundeanmeldt
IP ignoreres fjernadresser.

## Forbrugere

### macOS Instances-fanen

MacOS-appen gengiver outputtet af `system-presence` og anvender en lille statusindikator
(Aktiv/Idle/Forældet) baseret på alderen af den seneste opdatering.

## Fejlfindingstips

- For at se rålisten, kald `system-presence` mod Gateway.
- Hvis du ser dubletter:
  - bekræft, at klienter sender en stabil `client.instanceId` i handshake
  - bekræft, at periodiske beacons bruger den samme `instanceId`
  - tjek om den forbindelsesafledte post mangler `instanceId` (dubletter er forventede)
