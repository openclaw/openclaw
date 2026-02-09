---
summary: "Node-discovery en transports (Bonjour, Tailscale, SSH) voor het vinden van de gateway"
read_when:
  - Implementeren of wijzigen van Bonjour-discovery/-advertising
  - Aanpassen van externe verbindingsmodi (direct vs SSH)
  - Ontwerpen van node-discovery + pairing voor externe nodes
title: "Discovery en Transports"
---

# Discovery & transports

OpenClaw heeft twee afzonderlijke problemen die aan de oppervlakte op elkaar lijken:

1. **Externe bediening door de operator**: de macOS-menubalkapp die een Gateway bestuurt die elders draait.
2. **Node-pairing**: iOS/Android (en toekomstige nodes) die een Gateway vinden en veilig pairen.

Het ontwerpdoel is om alle netwerk-discovery/-advertising in de **Node Gateway** (`openclaw gateway`) te houden en clients (mac-app, iOS) als consumenten te laten fungeren.

## Termen

- **Gateway**: één langlopende Gateway-proces dat de state bezit (sessies, pairing, node-register) en kanalen draait. De meeste setups gebruiken er één per host; geïsoleerde multi-Gateway-setup zijn mogelijk.
- **Gateway WS (control plane)**: het WebSocket-eindpunt op `127.0.0.1:18789` standaard; kan aan LAN/tailnet worden gebonden via `gateway.bind`.
- **Direct WS transport**: een LAN-/tailnet-gericht Gateway WS-eindpunt (zonder SSH).
- **SSH transport (fallback)**: externe bediening door het forwarden van `127.0.0.1:18789` via SSH.
- **Legacy TCP bridge (verouderd/verwijderd)**: ouder node-transport (zie [Bridge protocol](/gateway/bridge-protocol)); niet langer geadverteerd voor discovery.

Protocoldetails:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Waarom we zowel “direct” als SSH behouden

- **Direct WS** biedt de beste UX op hetzelfde netwerk en binnen een tailnet:
  - auto-discovery op LAN via Bonjour
  - pairing-tokens + ACL’s in beheer van de Gateway
  - geen shell-toegang vereist; het protocoloppervlak kan strak en auditbaar blijven
- **SSH** blijft de universele fallback:
  - werkt overal waar je SSH-toegang hebt (zelfs over niet-verwante netwerken)
  - overleeft multicast/mDNS-problemen
  - vereist geen nieuwe inkomende poorten naast SSH

## Discovery-inputs (hoe clients leren waar de Gateway is)

### 1. Bonjour / mDNS (alleen LAN)

Bonjour is best-effort en gaat niet over netwerken heen. Het wordt alleen gebruikt voor gemak binnen “hetzelfde LAN”.

Doel richting:

- De **Gateway** adverteert zijn WS-eindpunt via Bonjour.
- Clients browsen en tonen een lijst “kies een Gateway”, en slaan daarna het gekozen eindpunt op.

Problemen oplossen en beacon-details: [Bonjour](/gateway/bonjour).

#### Service-beacon-details

- Servicetypen:
  - `_openclaw-gw._tcp` (Gateway-transportbeacon)
- TXT-sleutels (niet-geheim):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (of wat er ook geadverteerd wordt)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (alleen wanneer TLS is ingeschakeld)
  - `gatewayTlsSha256=<sha256>` (alleen wanneer TLS is ingeschakeld en een fingerprint beschikbaar is)
  - `canvasPort=18793` (standaard canvas-hostpoort; bedient `/__openclaw__/canvas/`)
  - `cliPath=<path>` (optioneel; absoluut pad naar een uitvoerbaar `openclaw`-entrypoint of binaire)
  - `tailnetDns=<magicdns>` (optionele hint; automatisch gedetecteerd wanneer Tailscale beschikbaar is)

Uitschakelen/overschrijven:

- `OPENCLAW_DISABLE_BONJOUR=1` schakelt adverteren uit.
- `gateway.bind` in `~/.openclaw/openclaw.json` bepaalt de Gateway-bindmodus.
- `OPENCLAW_SSH_PORT` overschrijft de SSH-poort die in TXT wordt geadverteerd (standaard 22).
- `OPENCLAW_TAILNET_DNS` publiceert een `tailnetDns`-hint (MagicDNS).
- `OPENCLAW_CLI_PATH` overschrijft het geadverteerde CLI-pad.

### 2. Tailnet (cross-network)

Voor London/Vienna-achtige setups helpt Bonjour niet. Het aanbevolen “directe” doel is:

- Tailscale MagicDNS-naam (bij voorkeur) of een stabiel tailnet-IP-adres.

Als de Gateway kan detecteren dat hij onder Tailscale draait, publiceert hij `tailnetDns` als optionele hint voor clients (inclusief wide-area beacons).

### 3. Handmatig / SSH-doel

Wanneer er geen directe route is (of direct is uitgeschakeld), kunnen clients altijd via SSH verbinden door de local loopback Gateway-poort te forwarden.

Zie [Remote access](/gateway/remote).

## Transportselectie (clientbeleid)

Aanbevolen clientgedrag:

1. Als een gepaird direct eindpunt is geconfigureerd en bereikbaar, gebruik dit.
2. Anders, als Bonjour een Gateway op LAN vindt, bied een een-tik-keuze “Gebruik deze Gateway” aan en sla deze op als het directe eindpunt.
3. Anders, als een tailnet-DNS/IP is geconfigureerd, probeer direct.
4. Anders, val terug op SSH.

## Pairing + auth (direct transport)

De Gateway is de bron van waarheid voor toelating van nodes/clients.

- Pairing-verzoeken worden aangemaakt/goedgekeurd/afgewezen in de Gateway (zie [Gateway pairing](/gateway/pairing)).
- De Gateway handhaaft:
  - authenticatie (token / sleutelpaar)
  - scopes/ACL’s (de Gateway is geen ruwe proxy naar elke methode)
  - rate limits

## Verantwoordelijkheden per component

- **Gateway**: adverteert discovery-beacons, beheert pairing-beslissingen en host het WS-eindpunt.
- **macOS-app**: helpt je een Gateway te kiezen, toont pairing-prompts en gebruikt SSH alleen als fallback.
- **iOS/Android-nodes**: browsen Bonjour als gemak en verbinden met de gepairde Gateway WS.
