---
summary: "Hur OpenClaw-närvaroposter skapas, slås samman och visas"
read_when:
  - Felsökning av fliken Instances
  - Undersökning av duplicerade eller inaktuella instansrader
  - Ändring av gatewayns WS-anslutning eller systemhändelse-beacons
title: "Närvaro"
---

# Närvaro

OpenClaw ”närvaro” är en lättviktig vy enligt best effort av:

- **Gateway**n själv, och
- **klienter som är anslutna till Gateway** (mac-app, WebChat, CLI, osv.)

Närvaro används främst för att rendera macOS-appens flik **Instances** och för att
ge operatörer snabb överblick.

## Närvarofält (vad som visas)

Närvaroposter är strukturerade objekt med fält som:

- `instanceId` (valfritt men starkt rekommenderat): stabil klientidentitet (vanligen `connect.client.instanceId`)
- `host`: lättläst värdnamn
- `ip`: IP-adress enligt best effort
- `version`: klientens versionssträng
- `deviceFamily` / `modelIdentifier`: hårdvaruindikationer
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: ”sekunder sedan senaste användarinmatning” (om känt)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: tidsstämpel för senaste uppdatering (ms sedan epok)

## Producenter (var närvaro kommer ifrån)

Närvaroposter produceras av flera källor och **slås samman**.

### 1. Gatewayns egen post

Gateway skapar alltid en ”egen”-post vid uppstart så att UI:er visar gateway-värden
redan innan några klienter ansluter.

### 2. WebSocket-anslutning

Varje WS-klient börjar med en `connect`-begäran. Vid lyckad handskakning höjer
Gateway en närvaropost för den anslutningen.

#### Varför engångskommandon i CLI inte syns

CLI ansluter ofta för korta, one‐off kommandon. För att undvika spamming av listan
instanser, `client.mode === "cli"` är **inte** förvandlas till en närvaropost.

### 3. `system-event`-beacons

Klienter kan skicka rikare periodiska fyrar via `system-event`-metoden. Appen mac
använder detta för att rapportera värdnamn, IP och `lastInputSeconds`.

### 4. Nodanslutningar (roll: node)

När en nod ansluter via Gateway-WebSocket med `role: node` uppdaterar Gateway
(en upsert) en närvaropost för den noden (samma flöde som för andra WS-klienter).

## Sammanfogning + deduplicering (varför `instanceId` är viktigt)

Närvaroposter lagras i en enda minnesbaserad map:

- Poster nycklas med en **närvaronyckel**.
- Den bästa nyckeln är en stabil `instanceId` (från `connect.client.instanceId`) som överlever omstarter.
- Nycklar är skiftlägesokänsliga.

Om en klient återansluter utan en stabil `instanceId` kan den visas som en
**duplicerad** rad.

## TTL och begränsad storlek

Närvaro är avsiktligt flyktig:

- **TTL:** poster äldre än 5 minuter rensas bort
- **Max antal poster:** 200 (äldsta tas bort först)

Detta håller listan aktuell och undviker obegränsad minnestillväxt.

## Fjärr-/tunnel-varning (loopback-IP:n)

När en klient ansluter över en SSH-tunnel / lokal port framåt kan Gateway
se fjärradressen som `127.0.0.1`. För att undvika att skriva över en bra klientrapporterad
IP-adresser ignoreras.

## Konsumenter

### macOS-fliken Instances

MacOS-appen renderar utdata från `system-presence` och tillämpar en liten
statusindikator (Active/Idle/Stale) baserat på åldern på den senaste uppdateringen.

## Felsökningstips

- För att se rålistan, anropa `system-presence` mot Gateway.
- Om du ser dubbletter:
  - bekräfta att klienter skickar en stabil `client.instanceId` i handskakningen
  - bekräfta att periodiska beacons använder samma `instanceId`
  - kontrollera om den anslutningshärledda posten saknar `instanceId` (dubbletter är förväntade)
