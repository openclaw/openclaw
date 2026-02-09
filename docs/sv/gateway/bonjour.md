---
summary: "Bonjour/mDNS-upptäckt + felsökning (Gateway-beacons, klienter och vanliga feltyper)"
read_when:
  - Felsökning av Bonjour-upptäcktsproblem på macOS/iOS
  - Ändra mDNS-tjänsttyper, TXT-poster eller upptäckts-UX
title: "Bonjour-upptäckt"
---

# Bonjour / mDNS-upptäckt

OpenClaw använder Bonjour (mDNS / DNS‐SD) som en **LAN‐only bekvämlighet** för att upptäcka
en aktiv Gateway (WebSocket slutpunkt). Den är bäst-ansträngning och ersätter **inte** SSH eller
Skailnet-baserad anslutning.

## Wide‑area Bonjour (Unicast DNS‑SD) över Tailscale

Om noden och gateway är på olika nätverk, multicast mDNS kommer inte att passera
gränsen. Du kan behålla samma upptäckt UX genom att växla till **unicast DNS‐SD**
("Wide‐Area Bonjour") över Tailscale.

Övergripande steg:

1. Kör en DNS‑server på gateway‑värden (nåbar över Tailnet).
2. Publicera DNS‑SD‑poster för `_openclaw-gw._tcp` under en dedikerad zon
   (exempel: `openclaw.internal.`).
3. Konfigurera Tailscale **split DNS** så att din valda domän löses via den
   DNS‑servern för klienter (inklusive iOS).

OpenClaw stöder alla upptäcktsdomäner; `openclaw.internal.` är bara ett exempel.
iOS/Android noder bläddra både `lokala` och din konfigurerade wide‐area domain.

### Gateway‑konfig (rekommenderas)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Engångsinstallation av DNS‑server (gateway‑värd)

```bash
openclaw dns setup --apply
```

Detta installerar CoreDNS och konfigurerar den att:

- lyssna på port 53 endast på gatewayens Tailscale‑gränssnitt
- betjäna din valda domän (exempel: `openclaw.internal.`) från `~/.openclaw/dns/<domain>.db`

Verifiera från en tailnet‑ansluten maskin:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS‑inställningar

I Tailscale‑administrationskonsolen:

- Lägg till en namnserver som pekar på gatewayens tailnet‑IP (UDP/TCP 53).
- Lägg till split DNS så att din upptäcktsdomän använder den namnservern.

När klienter accepterar tailnet‑DNS kan iOS‑noder bläddra i
`_openclaw-gw._tcp` i din upptäcktsdomän utan multicast.

### Gateway‑lyssnarsäkerhet (rekommenderas)

Gateway WS-porten (standard `18789`) binder till loopback som standard. För LAN/tailnet
åtkomst, bind explicit och håll auth aktiverad.

För tailnet‑endast‑uppsättningar:

- Sätt `gateway.bind: "tailnet"` i `~/.openclaw/openclaw.json`.
- Starta om Gateway (eller starta om macOS‑menyradsappen).

## Vad som annonseras

Endast Gateway annonserar `_openclaw-gw._tcp`.

## Tjänsttyper

- `_openclaw-gw._tcp` — gateway‑transportbeacon (används av macOS/iOS/Android‑noder).

## TXT‑nycklar (icke‑hemliga ledtrådar)

Gatewayn annonserar små icke‑hemliga ledtrådar för att göra UI‑flöden smidiga:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (endast när TLS är aktiverat)
- `gatewayTlsSha256=<sha256>` (endast när TLS är aktiverat och fingeravtryck finns)
- `canvasPort=<port>` (endast när canvas‑värden är aktiverad; standard `18793`)
- `sshPort=<port>` (standard 22 när den inte åsidosätts)
- `transport=gateway`
- `cliPath=<path>` (valfritt; absolut sökväg till en körbar `openclaw`‑entrypoint)
- `tailnetDns=<magicdns>` (valfri ledtråd när Tailnet är tillgängligt)

## Felsökning på macOS

Användbara inbyggda verktyg:

- Bläddra bland instanser:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Lös upp en instans (ersätt `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Om bläddring fungerar men upplösning misslyckas träffar du oftast på en LAN‑policy
eller ett mDNS‑resolverproblem.

## Felsökning i Gateway‑loggar

Gateway skriver en rullande loggfil (tryckt vid start som
`gateway loggfil: ...`). Leta efter `bonjour:` rader, särskilt:

- `bonjour: advertise failed ...`
- `bonjour: ... namnkonflikt löst` / `hostname konflikt löst`
- `bonjour: watchdog detected non-announced service ...`

## Felsökning på iOS‑nod

iOS‑noden använder `NWBrowser` för att upptäcka `_openclaw-gw._tcp`.

För att fånga loggar:

- Inställningar → Gateway → Avancerat → **Discovery Debug Logs**
- Inställningar → Gateway → Avancerat → **Discovery Logs** → återskapa → **Kopiera**

Loggen inkluderar tillståndsövergångar i webbläsaren och ändringar i resultatmängden.

## Vanliga feltyper

- **Bonjour passerar inte nätverk**: använd Tailnet eller SSH.
- **Multicast blockeras**: vissa Wi‑Fi‑nätverk inaktiverar mDNS.
- **Viloläge / gränssnittschurn**: macOS kan tillfälligt tappa mDNS‑resultat; försök igen.
- **Bläddra bland verk men lösa fel**: håll maskinnamnen enkla (undvik emojis eller
  skiljeturering), starta sedan om Gateway. Tjänsten instans namn härstammar från
  värdnamnet, så alltför komplexa namn kan förvirra vissa resolvers.

## Escapade instansnamn (`\032`)

Bonjour/DNS‑SD escaper ofta byte i tjänstinstansnamn som decimala `\DDD`‑
sekvenser (t.ex. blir mellanslag `\032`).

- Detta är normalt på protokollnivå.
- UI:n bör avkoda för visning (iOS använder `BonjourEscapes.decode`).

## Inaktivering / konfiguration

- `OPENCLAW_DISABLE_BONJOUR=1` inaktiverar annonsering (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` i `~/.openclaw/openclaw.json` styr Gatewayns bind‑läge.
- `OPENCLAW_SSH_PORT` åsidosätter SSH‑porten som annonseras i TXT (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publicerar en MagicDNS‑ledtråd i TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` åsidosätter den annonserade CLI‑sökvägen (legacy: `OPENCLAW_CLI_PATH`).

## Relaterad dokumentation

- Upptäcktspolicy och transportval: [Discovery](/gateway/discovery)
- Nodparkoppling + godkännanden: [Gateway pairing](/gateway/pairing)
