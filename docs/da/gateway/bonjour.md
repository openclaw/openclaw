---
summary: "Bonjour/mDNS-discovery + fejlfinding (Gateway-beacons, klienter og almindelige fejltilstande)"
read_when:
  - Fejlfinding af Bonjour-discovery-problemer på macOS/iOS
  - Ændring af mDNS-servicetyper, TXT-poster eller discovery-UX
title: "Bonjour-discovery"
x-i18n:
  source_path: gateway/bonjour.md
  source_hash: 6f1d676ded5a500c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:21Z
---

# Bonjour / mDNS-discovery

OpenClaw bruger Bonjour (mDNS / DNS‑SD) som en **LAN‑kun bekvemmelighed** til at opdage
en aktiv Gateway (WebSocket-endpoint). Det er best‑effort og **erstatter ikke** SSH eller
Tailnet-baseret forbindelser.

## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale

Hvis noden og gatewayen er på forskellige netværk, krydser multicast mDNS ikke
grænsen. Du kan bevare den samme discovery-UX ved at skifte til **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

Overordnede trin:

1. Kør en DNS-server på gateway-værten (tilgængelig over Tailnet).
2. Udgiv DNS‑SD-poster for `_openclaw-gw._tcp` under en dedikeret zone
   (eksempel: `openclaw.internal.`).
3. Konfigurer Tailscale **split DNS**, så dit valgte domæne resolver via den
   DNS-server for klienter (inklusive iOS).

OpenClaw understøtter ethvert discovery-domæne; `openclaw.internal.` er blot et eksempel.
iOS/Android-noder browser både `local.` og dit konfigurerede wide‑area-domæne.

### Gateway-konfiguration (anbefalet)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Engangsopsætning af DNS-server (gateway-vært)

```bash
openclaw dns setup --apply
```

Dette installerer CoreDNS og konfigurerer den til at:

- lytte på port 53 kun på gatewayens Tailscale-interfaces
- servere dit valgte domæne (eksempel: `openclaw.internal.`) fra `~/.openclaw/dns/<domain>.db`

Validér fra en tailnet-tilsluttet maskine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS-indstillinger

I Tailscale-administrationskonsollen:

- Tilføj en navneserver, der peger på gatewayens tailnet-IP (UDP/TCP 53).
- Tilføj split DNS, så dit discovery-domæne bruger den navneserver.

Når klienter accepterer tailnet-DNS, kan iOS-noder browse
`_openclaw-gw._tcp` i dit discovery-domæne uden multicast.

### Gateway-lytterens sikkerhed (anbefalet)

Gatewayens WS-port (standard `18789`) binder som standard til loopback. For LAN/tailnet
adgang skal du binde eksplicit og beholde autentificering aktiveret.

For tailnet‑kun opsætninger:

- Sæt `gateway.bind: "tailnet"` i `~/.openclaw/openclaw.json`.
- Genstart Gateway (eller genstart macOS-menulinjeappen).

## Hvad annoncerer

Kun Gatewayen annoncerer `_openclaw-gw._tcp`.

## Servicetyper

- `_openclaw-gw._tcp` — gateway-transportbeacon (bruges af macOS/iOS/Android-noder).

## TXT-nøgler (ikke‑hemmelige hints)

Gatewayen annoncerer små, ikke‑hemmelige hints for at gøre UI‑flows bekvemme:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (kun når TLS er aktiveret)
- `gatewayTlsSha256=<sha256>` (kun når TLS er aktiveret og fingerprint er tilgængeligt)
- `canvasPort=<port>` (kun når canvas-værten er aktiveret; standard `18793`)
- `sshPort=<port>` (standard er 22, når den ikke er tilsidesat)
- `transport=gateway`
- `cliPath=<path>` (valgfri; absolut sti til et kørbart `openclaw` entrypoint)
- `tailnetDns=<magicdns>` (valgfrit hint, når Tailnet er tilgængeligt)

## Fejlfinding på macOS

Nyttige indbyggede værktøjer:

- Browse instanser:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Resolve én instans (erstat `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Hvis browsing virker, men resolve fejler, rammer du typisk en LAN‑politik eller et
mDNS-resolverproblem.

## Fejlfinding i Gateway-logs

Gatewayen skriver en rullende logfil (udskrevet ved opstart som
`gateway log file: ...`). Kig efter `bonjour:`‑linjer, især:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Fejlfinding på iOS-node

iOS-noden bruger `NWBrowser` til at opdage `_openclaw-gw._tcp`.

Sådan indsamler du logs:

- Indstillinger → Gateway → Avanceret → **Discovery Debug Logs**
- Indstillinger → Gateway → Avanceret → **Discovery Logs** → reproducer → **Kopiér**

Loggen indeholder tilstandsskift for browseren og ændringer i resultatsættet.

## Almindelige fejltilstande

- **Bonjour krydser ikke netværk**: brug Tailnet eller SSH.
- **Multicast blokeret**: nogle Wi‑Fi-netværk deaktiverer mDNS.
- **Sleep / interface-churn**: macOS kan midlertidigt miste mDNS‑resultater; prøv igen.
- **Browse virker, men resolve fejler**: hold maskinnavne simple (undgå emojis eller
  tegnsætning), og genstart derefter Gateway. Serviceinstansens navn afledes af
  værtsnavnet, så alt for komplekse navne kan forvirre nogle resolvere.

## Escapede instansnavne (`\032`)

Bonjour/DNS‑SD escaper ofte bytes i serviceinstansnavne som decimale `\DDD`‑
sekvenser (f.eks. bliver mellemrum til `\032`).

- Dette er normalt på protokolniveau.
- UI’er bør afkode til visning (iOS bruger `BonjourEscapes.decode`).

## Deaktivering / konfiguration

- `OPENCLAW_DISABLE_BONJOUR=1` deaktiverer annoncering (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` i `~/.openclaw/openclaw.json` styrer Gatewayens bind-tilstand.
- `OPENCLAW_SSH_PORT` tilsidesætter SSH-porten, der annonceres i TXT (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` udgiver et MagicDNS-hint i TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` tilsidesætter den annoncerede CLI-sti (legacy: `OPENCLAW_CLI_PATH`).

## Relaterede dokumenter

- Discovery-politik og transportvalg: [Discovery](/gateway/discovery)
- Node-parring + godkendelser: [Gateway pairing](/gateway/pairing)
