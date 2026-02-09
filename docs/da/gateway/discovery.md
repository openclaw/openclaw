---
summary: "Node-discovery og transporter (Bonjour, Tailscale, SSH) til at finde gatewayen"
read_when:
  - Implementering eller ændring af Bonjour-discovery/annoncering
  - Justering af fjernforbindelsestilstande (direkte vs. SSH)
  - Design af node-discovery + parring for fjernnoder
title: "Discovery og transporter"
---

# Discovery & transporter

OpenClaw har to adskilte problemer, som på overfladen ligner hinanden:

1. **Operatørens fjernstyring**: macOS-menulinjeappen, der styrer en gateway, som kører et andet sted.
2. **Node-parring**: iOS/Android (og fremtidige noder), der finder en gateway og parrer sikkert.

Designmålet er at samle al netværks-discovery/annoncering i **Node Gateway** (`openclaw gateway`) og holde klienter (mac-app, iOS) som forbrugere.

## Termer

- **Gateway**: En enkelt langtløbende gatewayproces, der ejer tilstand (sessioner, parring, node registreringsdatabase) og kører kanaler. De fleste opsætninger bruger en pr. vært; isolerede multi-gateway opsætninger er mulige.
- **Gateway WS (kontrolplan)**: WebSocket-endpointet på `127.0.0.1:18789` som standard; kan bindes til LAN/tailnet via `gateway.bind`.
- **Direkte WS-transport**: et LAN-/tailnet-vendt Gateway WS-endpoint (ingen SSH).
- **SSH-transport (fallback)**: fjernstyring ved at videresende `127.0.0.1:18789` over SSH.
- **Legacy TCP-bridge (forældet/fjernet)**: ældre nodetransport (se [Bridge protocol](/gateway/bridge-protocol)); annonceres ikke længere til discovery.

Protokoldetaljer:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Hvorfor vi beholder både “direkte” og SSH

- **Direkte WS** giver den bedste UX på samme netværk og inden for et tailnet:
  - auto-discovery på LAN via Bonjour
  - parringstokens + ACL’er ejet af gatewayen
  - ingen shell-adgang krævet; protokolfladen kan forblive stram og auditerbar
- **SSH** forbliver den universelle fallback:
  - virker overalt, hvor du har SSH-adgang (selv på tværs af uafhængige netværk)
  - overlever multicast/mDNS-problemer
  - kræver ingen nye indgående porte ud over SSH

## Discovery-inputs (hvordan klienter lærer, hvor gatewayen er)

### 1. Bonjour / mDNS (kun LAN)

Bonjour er den bedste indsats og krydser ikke netværk. Det bruges kun til “samme LAN” bekvemmelighed.

Målretning:

- **Gatewayen** annoncerer sit WS-endpoint via Bonjour.
- Klienter gennemser og viser en “vælg en gateway”-liste og gemmer derefter det valgte endpoint.

Fejlfinding og beacon-detaljer: [Bonjour](/gateway/bonjour).

#### Service beacon-detaljer

- Servicetyper:
  - `_openclaw-gw._tcp` (gateway-transport-beacon)
- TXT-nøgler (ikke-hemmelige):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (eller hvad der end annonceres)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (kun når TLS er aktiveret)
  - `gatewayTlsSha256=<sha256>` (kun når TLS er aktiveret, og fingeraftryk er tilgængeligt)
  - `canvasPort=18793` (standard canvas-værtsport; serverer `/__openclaw__/canvas/`)
  - `cliPath=<path>` (valgfri; absolut sti til et kørbart `openclaw`-entrypoint eller binær)
  - `tailnetDns=<magicdns>` (valgfrit hint; auto-detekteres, når Tailscale er tilgængelig)

Deaktiver/overstyr:

- `OPENCLAW_DISABLE_BONJOUR=1` deaktiverer annoncering.
- `gateway.bind` i `~/.openclaw/openclaw.json` styrer Gateway-bind-tilstanden.
- `OPENCLAW_SSH_PORT` overstyrer SSH-porten, der annonceres i TXT (standard er 22).
- `OPENCLAW_TAILNET_DNS` publicerer et `tailnetDns`-hint (MagicDNS).
- `OPENCLAW_CLI_PATH` overstyrer den annoncerede CLI-sti.

### 2. Tailnet (på tværs af netværk)

For opsætninger i London/Wien, vil Bonjour ikke hjælpe. Det anbefalede “direkte” mål er:

- Tailscale MagicDNS-navn (foretrukket) eller en stabil tailnet-IP.

Hvis gatewayen kan registrere, at den kører under Tailscale, publicerer den `tailnetDns` som et valgfrit hint til klienter (inklusive wide-area beacons).

### 3. Manuel / SSH-mål

Når der ikke er en direkte rute (eller direkte er deaktiveret), kan klienter altid forbinde via SSH ved at videresende loopback-gateway-porten.

Se [Remote access](/gateway/remote).

## Transportvalg (klientpolitik)

Anbefalet klientadfærd:

1. Hvis et parret direkte endpoint er konfigureret og tilgængeligt, brug det.
2. Ellers, hvis Bonjour finder en gateway på LAN, tilbyd et ét-tryk “Brug denne gateway”-valg og gem det som det direkte endpoint.
3. Ellers, hvis et tailnet-DNS/IP er konfigureret, prøv direkte.
4. Ellers, fald tilbage til SSH.

## Parring + auth (direkte transport)

Gatewayen er sandhedskilden for node-/klientadgang.

- Parringsanmodninger oprettes/godkendes/afvises i gatewayen (se [Gateway pairing](/gateway/pairing)).
- Gatewayen håndhæver:
  - auth (token / nøglepar)
  - scopes/ACL’er (gatewayen er ikke en rå proxy til alle metoder)
  - rate limits

## Ansvar pr. komponent

- **Gateway**: annoncerer discovery-beacons, ejer parringsbeslutninger og hoster WS-endpointet.
- **macOS-app**: hjælper dig med at vælge en gateway, viser parringsprompter og bruger kun SSH som fallback.
- **iOS/Android-noder**: gennemser Bonjour som en bekvemmelighed og forbinder til den parrede Gateway WS.
