---
summary: "Discovery ng node at mga transport (Bonjour, Tailscale, SSH) para sa paghahanap ng Gateway"
read_when:
  - Pagpapatupad o pagbabago ng Bonjour discovery/advertising
  - Pag-aayos ng mga remote connection mode (direct vs SSH)
  - Pagdidisenyo ng node discovery + pairing para sa mga remote node
title: "Discovery at mga Transport"
---

# Discovery & transports

May dalawang magkahiwalay na problema ang OpenClaw na mukhang magkapareho sa unang tingin:

1. **Remote control ng operator**: ang macOS menu bar app na kumokontrol sa isang gateway na tumatakbo sa ibang lugar.
2. **Node pairing**: iOS/Android (at mga node sa hinaharap) na naghahanap ng Gateway at ligtas na nagpa-pair.

Ang layunin ng disenyo ay panatilihin ang lahat ng network discovery/advertising sa **Node Gateway** (`openclaw gateway`) at panatilihin ang mga client (mac app, iOS) bilang mga consumer.

## Mga termino

- **Gateway**: a single long-running gateway process that owns state (sessions, pairing, node registry) and runs channels. Most setups use one per host; isolated multi-gateway setups are possible.
- **Gateway WS (control plane)**: ang WebSocket endpoint sa `127.0.0.1:18789` bilang default; maaaring i-bind sa LAN/tailnet sa pamamagitan ng `gateway.bind`.
- **Direct WS transport**: isang LAN/tailnet-facing na Gateway WS endpoint (walang SSH).
- **SSH transport (fallback)**: remote control sa pamamagitan ng pag-forward ng `127.0.0.1:18789` sa SSH.
- **Legacy TCP bridge (deprecated/removed)**: mas lumang node transport (tingnan ang [Bridge protocol](/gateway/bridge-protocol)); hindi na ina-advertise para sa discovery.

Mga detalye ng protocol:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Bakit pinananatili namin ang parehong “direct” at SSH

- **Direct WS** ang may pinakamagandang UX sa parehong network at sa loob ng isang tailnet:
  - auto-discovery sa LAN sa pamamagitan ng Bonjour
  - pairing tokens + ACLs na pagmamay-ari ng Gateway
  - walang kinakailangang shell access; maaaring manatiling mahigpit at auditable ang protocol surface
- **SSH** ay nananatiling unibersal na fallback:
  - gumagana kahit saan may SSH access ka (kahit sa magkakahiwalay na network)
  - nakakalampas sa mga isyu ng multicast/mDNS
  - walang kinakailangang bagong inbound ports bukod sa SSH

## Discovery inputs (paano nalalaman ng mga client kung nasaan ang Gateway)

### 1. Bonjour / mDNS (LAN lamang)

Bonjour is best-effort and does not cross networks. Ginagamit lamang ito para sa kaginhawaan ng “parehong LAN.”

Target na direksyon:

- Ina-advertise ng **Gateway** ang WS endpoint nito sa pamamagitan ng Bonjour.
- Nagba-browse ang mga client at nagpapakita ng listahang “pumili ng Gateway”, pagkatapos ay sine-save ang napiling endpoint.

Mga detalye sa pag-troubleshoot at beacon: [Bonjour](/gateway/bonjour).

#### Mga detalye ng service beacon

- Mga uri ng serbisyo:
  - `_openclaw-gw._tcp` (gateway transport beacon)
- Mga TXT key (hindi lihim):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (o kung ano man ang ina-advertise)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (kapag naka-enable lang ang TLS)
  - `gatewayTlsSha256=<sha256>` (kapag naka-enable ang TLS at available ang fingerprint)
  - `canvasPort=18793` (default na canvas host port; naghahain ng `/__openclaw__/canvas/`)
  - `cliPath=<path>` (opsyonal; absolute path sa isang runnable na `openclaw` entrypoint o binary)
  - `tailnetDns=<magicdns>` (opsyonal na hint; auto-detected kapag available ang Tailscale)

I-disable/i-override:

- `OPENCLAW_DISABLE_BONJOUR=1` ay nagdi-disable ng advertising.
- Kinokontrol ng `gateway.bind` sa `~/.openclaw/openclaw.json` ang Gateway bind mode.
- Ina-override ng `OPENCLAW_SSH_PORT` ang SSH port na ina-advertise sa TXT (default ay 22).
- Nagpa-publish ang `OPENCLAW_TAILNET_DNS` ng isang `tailnetDns` hint (MagicDNS).
- Ina-override ng `OPENCLAW_CLI_PATH` ang ina-advertise na CLI path.

### 2. Tailnet (cross-network)

For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:

- Tailscale MagicDNS name (mas gusto) o isang stable na tailnet IP.

Kung matukoy ng Gateway na ito ay tumatakbo sa ilalim ng Tailscale, ipo-publish nito ang `tailnetDns` bilang isang opsyonal na hint para sa mga client (kabilang ang mga wide-area beacon).

### 3. Manual / SSH target

Kapag walang direct route (o naka-disable ang direct), palaging maaaring kumonekta ang mga client sa pamamagitan ng SSH sa pamamagitan ng pag-forward ng loopback gateway port.

Tingnan ang [Remote access](/gateway/remote).

## Pagpili ng transport (client policy)

Inirerekomendang asal ng client:

1. Kung may naka-configure at reachable na paired direct endpoint, gamitin ito.
2. Kung hindi, kung may makita ang Bonjour na Gateway sa LAN, mag-alok ng one-tap na “Gamitin ang Gateway na ito” at i-save ito bilang direct endpoint.
3. Kung hindi, kung may naka-configure na tailnet DNS/IP, subukan ang direct.
4. Kung hindi pa rin, bumalik sa SSH.

## Pairing + auth (direct transport)

Ang Gateway ang source of truth para sa admission ng node/client.

- Ang mga pairing request ay nililikha/inaaprubahan/itinatatwa sa Gateway (tingnan ang [Gateway pairing](/gateway/pairing)).
- Ipinapatupad ng Gateway ang:
  - auth (token / keypair)
  - scopes/ACLs (ang Gateway ay hindi raw proxy sa bawat method)
  - mga rate limit

## Mga responsibilidad ayon sa component

- **Gateway**: nag-a-advertise ng mga discovery beacon, nagmamay-ari ng mga desisyon sa pairing, at nagho-host ng WS endpoint.
- **macOS app**: tumutulong pumili ng Gateway, nagpapakita ng mga pairing prompt, at gumagamit ng SSH bilang fallback lamang.
- **iOS/Android nodes**: nagba-browse ng Bonjour bilang kaginhawaan at kumokonekta sa paired na Gateway WS.
