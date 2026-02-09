---
summary: "Nodupptäckt och transporter (Bonjour, Tailscale, SSH) för att hitta gatewayn"
read_when:
  - Implementerar eller ändrar Bonjour-upptäckt/annonsering
  - Justerar fjärranslutningslägen (direkt vs SSH)
  - Utformar nodupptäckt + parning för fjärrnoder
title: "Discovery och transporter"
---

# Discovery & transporter

OpenClaw har två skilda problem som ser likadana ut på ytan:

1. **Operatörens fjärrstyrning**: macOS-menyradsappen som styr en gateway som körs någon annanstans.
2. **Nodparning**: iOS/Android (och framtida noder) som hittar en gateway och parar säkert.

Designmålet är att hålla all nätverksupptäckt/annonsering i **Node Gateway** (`openclaw gateway`) och låta klienter (mac-app, iOS) vara konsumenter.

## Termer

- **Gateway**: en enda långvarig gateway-process som äger tillstånd (sessioner, parning, nodregistret) och kör kanaler. De flesta inställningar använder en per värd, isolerade multi-gateway-inställningar är möjliga.
- **Gateway WS (kontrollplan)**: WebSocket-ändpunkten på `127.0.0.1:18789` som standard; kan bindas till LAN/tailnet via `gateway.bind`.
- **Direkt WS-transport**: en LAN-/tailnet-exponerad Gateway WS-ändpunkt (ingen SSH).
- **SSH-transport (fallback)**: fjärrstyrning genom att vidarebefordra `127.0.0.1:18789` över SSH.
- **Legacy TCP-brygga (föråldrad/borttagen)**: äldre nodtransport (se [Bridge protocol](/gateway/bridge-protocol)); annonseras inte längre för upptäckt.

Protokolldetaljer:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Varför vi behåller både ”direkt” och SSH

- **Direkt WS** ger bäst UX på samma nätverk och inom ett tailnet:
  - automatisk upptäckt på LAN via Bonjour
  - parningstoken + ACL:er ägs av gatewayn
  - ingen shell-åtkomst krävs; protokollytan kan hållas snäv och granskningsbar
- **SSH** förblir den universella fallbacken:
  - fungerar överallt där du har SSH-åtkomst (även över orelaterade nätverk)
  - överlever multicast/mDNS-problem
  - kräver inga nya inkommande portar utöver SSH

## Discovery-indata (hur klienter får veta var gatewayn finns)

### 1. Bonjour / mDNS (endast LAN)

Bonjour är bäst och korsar inte nätverk. Det används bara för “samma LAN” bekvämlighet.

Målriktning:

- **Gatewayn** annonserar sin WS-ändpunkt via Bonjour.
- Klienter bläddrar och visar en lista ”välj en gateway”, och lagrar sedan den valda ändpunkten.

Felsökning och beacon-detaljer: [Bonjour](/gateway/bonjour).

#### Service beacon-detaljer

- Tjänsttyper:
  - `_openclaw-gw._tcp` (gateway-transportbeacon)
- TXT-nycklar (icke-hemliga):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (eller vad som än annonseras)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (endast när TLS är aktiverat)
  - `gatewayTlsSha256=<sha256>` (endast när TLS är aktiverat och fingeravtryck är tillgängligt)
  - `canvasPort=18793` (standardport för canvas-värd; serverar `/__openclaw__/canvas/`)
  - `cliPath=<path>` (valfri; absolut sökväg till en körbar `openclaw`-entrypoint eller binär)
  - `tailnetDns=<magicdns>` (valfritt tips; auto-detekteras när Tailscale är tillgängligt)

Inaktivera/åsidosätt:

- `OPENCLAW_DISABLE_BONJOUR=1` inaktiverar annonsering.
- `gateway.bind` i `~/.openclaw/openclaw.json` styr Gatewayns bindningsläge.
- `OPENCLAW_SSH_PORT` åsidosätter SSH-porten som annonseras i TXT (standard är 22).
- `OPENCLAW_TAILNET_DNS` publicerar ett `tailnetDns`-tips (MagicDNS).
- `OPENCLAW_CLI_PATH` åsidosätter den annonserade CLI-sökvägen.

### 2. Tailnet (över nätverk)

För London/Wien stil uppsättningar kommer Bonjour inte att hjälpa. Det rekommenderade ”direkt” målet är:

- Tailscale MagicDNS-namn (föredras) eller en stabil tailnet-IP.

Om gatewayn kan upptäcka att den körs under Tailscale publicerar den `tailnetDns` som ett valfritt tips för klienter (inklusive wide-area-beacons).

### 3. Manuell / SSH-mål

När det inte finns någon direkt rutt (eller direkt är inaktiverat) kan klienter alltid ansluta via SSH genom att vidarebefordra loopback-gatewayporten.

Se [Remote access](/gateway/remote).

## Transportval (klientpolicy)

Rekommenderat klientbeteende:

1. Om en parad direkt-ändpunkt är konfigurerad och nåbar, använd den.
2. Annars, om Bonjour hittar en gateway på LAN, erbjud ett ett-trycks-val ”Använd denna gateway” och spara den som direkt-ändpunkt.
3. Annars, om ett tailnet-DNS/IP är konfigurerat, prova direkt.
4. Annars, fall tillbaka till SSH.

## Parning + autentisering (direkt transport)

Gatewayn är sanningskällan för nod-/klientantagning.

- Parförfrågningar skapas/godkänns/avslås i gatewayn (se [Gateway pairing](/gateway/pairing)).
- Gatewayn upprätthåller:
  - autentisering (token / nyckelpar)
  - scopes/ACL:er (gatewayn är inte en rå proxy till varje metod)
  - hastighetsbegränsningar

## Ansvar per komponent

- **Gateway**: annonserar discovery-beacons, äger parningsbeslut och är värd för WS-ändpunkten.
- **macOS-app**: hjälper dig att välja en gateway, visar parningsuppmaningar och använder SSH endast som fallback.
- **iOS/Android-noder**: bläddrar i Bonjour som en bekvämlighet och ansluter till den parade Gateway WS.
