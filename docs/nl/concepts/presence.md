---
summary: "Hoe OpenClaw-presencevermeldingen worden geproduceerd, samengevoegd en weergegeven"
read_when:
  - Debuggen van het tabblad Instances
  - Onderzoeken van dubbele of verouderde instancerijen
  - Wijzigen van gateway WS-connectie of systeemgebeurtenis-beacons
title: "Presence"
---

# Presence

OpenClaw “presence” is een lichtgewicht, best‑effort overzicht van:

- de **Gateway** zelf, en
- **clients die met de Gateway zijn verbonden** (mac-app, WebChat, CLI, enz.)

Presence wordt voornamelijk gebruikt om het tabblad **Instances** van de macOS‑app te renderen en om snelle zichtbaarheid voor operators te bieden.

## Presence-velden (wat wordt weergegeven)

Presencevermeldingen zijn gestructureerde objecten met velden zoals:

- `instanceId` (optioneel maar sterk aanbevolen): stabiele clientidentiteit (meestal `connect.client.instanceId`)
- `host`: mensvriendelijke hostnaam
- `ip`: best‑effort IP-adres
- `version`: clientversiestring
- `deviceFamily` / `modelIdentifier`: hardware-indicaties
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “seconden sinds laatste gebruikersinvoer” (indien bekend)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: tijdstempel van laatste update (ms sinds epoch)

## Producenten (waar presence vandaan komt)

Presencevermeldingen worden door meerdere bronnen geproduceerd en **samengevoegd**.

### 1. Gateway-eigen vermelding

De Gateway initialiseert bij het opstarten altijd een “self”-vermelding, zodat UI’s de gateway-host tonen, zelfs voordat clients verbinding maken.

### 2. WebSocket-connectie

Elke WS-client begint met een `connect`-verzoek. Bij een succesvolle handshake voegt de Gateway een presencevermelding toe of werkt deze bij voor die verbinding.

#### Waarom eenmalige CLI-opdrachten niet verschijnen

De CLI maakt vaak verbinding voor korte, eenmalige opdrachten. Om te voorkomen dat de Instances-lijst wordt gespamd, wordt `client.mode === "cli"` **niet** omgezet in een presencevermelding.

### 3. `system-event`-beacons

Clients kunnen rijkere periodieke beacons sturen via de methode `system-event`. De mac-app gebruikt dit om hostnaam, IP en `lastInputSeconds` te rapporteren.

### 4. Node-verbindingen (rol: node)

Wanneer een node verbinding maakt via de Gateway WebSocket met `role: node`, voegt de Gateway een presencevermelding toe of werkt deze bij voor die node (zelfde stroom als andere WS-clients).

## Samenvoegen + deduplicatie (waarom `instanceId` ertoe doet)

Presencevermeldingen worden opgeslagen in één in‑memory map:

- Vermeldingen worden gesleuteld op een **presence-sleutel**.
- De beste sleutel is een stabiele `instanceId` (van `connect.client.instanceId`) die herstarts overleeft.
- Sleutels zijn niet hoofdlettergevoelig.

Als een client opnieuw verbindt zonder een stabiele `instanceId`, kan deze als een **dubbele** rij verschijnen.

## TTL en begrensde grootte

Presence is bewust vluchtig:

- **TTL:** vermeldingen ouder dan 5 minuten worden opgeschoond
- **Max. vermeldingen:** 200 (oudste worden eerst verwijderd)

Dit houdt de lijst actueel en voorkomt onbeperkte geheugen­groei.

## Remote/tunnel‑kanttekening (loopback-IP’s)

Wanneer een client verbinding maakt via een SSH-tunnel / lokale portforward, kan de Gateway het externe adres zien als `127.0.0.1`. Om te voorkomen dat een goed door de client gerapporteerd IP wordt overschreven, worden loopback-externe adressen genegeerd.

## Consumenten

### macOS-tabblad Instances

De macOS‑app rendert de uitvoer van `system-presence` en past een kleine statusindicator toe (Actief/Idle/Verouderd) op basis van de leeftijd van de laatste update.

## Debuggingtips

- Om de ruwe lijst te zien, roep `system-presence` aan tegen de Gateway.
- Als je duplicaten ziet:
  - bevestig dat clients een stabiele `client.instanceId` in de handshake sturen
  - bevestig dat periodieke beacons dezelfde `instanceId` gebruiken
  - controleer of de van de verbinding afgeleide vermelding `instanceId` mist (duplicaten zijn dan te verwachten)
