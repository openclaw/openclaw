---
summary: "Bonjour/mDNS-discovery + debugging (Gateway-beacons, clients en veelvoorkomende foutmodi)"
read_when:
  - Debuggen van Bonjour-discoveryproblemen op macOS/iOS
  - Wijzigen van mDNS-servicetypen, TXT-records of discovery-UX
title: "Bonjour-discovery"
---

# Bonjour / mDNS-discovery

OpenClaw gebruikt Bonjour (mDNS / DNS‑SD) als een **LAN‑only gemak** om
een actieve Gateway (WebSocket-endpoint) te ontdekken. Het is best‑effort en
vervangt **niet** SSH of Tailnet‑gebaseerde connectiviteit.

## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale

Als de node en de gateway zich op verschillende netwerken bevinden, gaat
multicast mDNS niet over die grens. Je kunt dezelfde discovery‑UX behouden
door over te schakelen op **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

Hogere stappen op niveau:

1. Draai een DNS‑server op de Gateway-host (bereikbaar via Tailnet).
2. Publiceer DNS‑SD‑records voor `_openclaw-gw._tcp` onder een aparte zone
   (voorbeeld: `openclaw.internal.`).
3. Configureer Tailscale **split DNS** zodat je gekozen domein via die
   DNS‑server wordt opgelost voor clients (inclusief iOS).

OpenClaw ondersteunt elk discovery‑domein; `openclaw.internal.` is slechts een voorbeeld.
iOS/Android-nodes doorzoeken zowel `local.` als je geconfigureerde wide‑area‑domein.

### Gateway-config (aanbevolen)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Eenmalige DNS‑serverinstallatie (Gateway-host)

```bash
openclaw dns setup --apply
```

Dit installeert CoreDNS en configureert het om:

- te luisteren op poort 53 alleen op de Tailscale‑interfaces van de Gateway
- je gekozen domein (voorbeeld: `openclaw.internal.`) te serveren vanuit `~/.openclaw/dns/<domain>.db`

Valideer vanaf een met het tailnet verbonden machine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS-instellingen

In de Tailscale‑beheerconsole:

- Voeg een nameserver toe die verwijst naar het tailnet‑IP van de Gateway (UDP/TCP 53).
- Voeg split DNS toe zodat je discovery‑domein die nameserver gebruikt.

Zodra clients tailnet‑DNS accepteren, kunnen iOS‑nodes
`_openclaw-gw._tcp` in je discovery‑domein doorzoeken zonder multicast.

### Gateway‑listenerbeveiliging (aanbevolen)

De Gateway WS‑poort (standaard `18789`) bindt standaard aan loopback. Voor LAN/tailnet‑toegang
bind expliciet en houd authenticatie ingeschakeld.

Voor tailnet‑only‑opstellingen:

- Stel `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` in.
- Herstart de Gateway (of herstart de macOS‑menubalkapp).

## Wat adverteert

Alleen de Gateway adverteert `_openclaw-gw._tcp`.

## Servicetypen

- `_openclaw-gw._tcp` — Gateway‑transportbeacon (gebruikt door macOS/iOS/Android‑nodes).

## TXT‑sleutels (niet‑geheime hints)

De Gateway adverteert kleine niet‑geheime hints om UI‑flows handig te maken:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (alleen wanneer TLS is ingeschakeld)
- `gatewayTlsSha256=<sha256>` (alleen wanneer TLS is ingeschakeld en een vingerafdruk beschikbaar is)
- `canvasPort=<port>` (alleen wanneer de canvas‑host is ingeschakeld; standaard `18793`)
- `sshPort=<port>` (standaard 22 wanneer niet overschreven)
- `transport=gateway`
- `cliPath=<path>` (optioneel; absoluut pad naar een uitvoerbare `openclaw`‑entrypoint)
- `tailnetDns=<magicdns>` (optionele hint wanneer Tailnet beschikbaar is)

## Debugging op macOS

Handige ingebouwde tools:

- Blader door instanties:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Eén instantie resolven (vervang `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Als doorzoeken werkt maar resolven faalt, loop je meestal tegen een LAN‑beleid
of een mDNS‑resolverprobleem aan.

## Debugging in Gateway‑logs

De Gateway schrijft een rollend logbestand (bij het opstarten afgedrukt als
`gateway log file: ...`). Let op regels met `bonjour:`, met name:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugging op iOS‑node

De iOS‑node gebruikt `NWBrowser` om `_openclaw-gw._tcp` te ontdekken.

Logs vastleggen:

- Instellingen → Gateway → Geavanceerd → **Discovery Debug Logs**
- Instellingen → Gateway → Geavanceerd → **Discovery Logs** → reproduceer → **Kopiëren**

Het log bevat statusovergangen van de browser en wijzigingen in de resultatenset.

## Veelvoorkomende foutmodi

- **Bonjour gaat niet over netwerken heen**: gebruik Tailnet of SSH.
- **Multicast geblokkeerd**: sommige wifi‑netwerken schakelen mDNS uit.
- **Slaapstand / interface‑churn**: macOS kan mDNS‑resultaten tijdelijk laten vallen; probeer opnieuw.
- **Doorzoeken werkt maar resolven faalt**: houd machinenamen eenvoudig (vermijd emoji’s of
  leestekens) en herstart daarna de Gateway. De servicenaam wordt afgeleid van
  de hostnaam, dus te complexe namen kunnen sommige resolvers in de war brengen.

## Geëscapete instantienamen (`\032`)

Bonjour/DNS‑SD escapt vaak bytes in servicenaam‑instanties als decimale `\DDD`‑
reeksen (bijv. spaties worden `\032`).

- Dit is normaal op protocolniveau.
- UI’s moeten dit decoderen voor weergave (iOS gebruikt `BonjourEscapes.decode`).

## Uitschakelen / configuratie

- `OPENCLAW_DISABLE_BONJOUR=1` schakelt adverteren uit (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` in `~/.openclaw/openclaw.json` bepaalt de bind‑modus van de Gateway.
- `OPENCLAW_SSH_PORT` overschrijft de SSH‑poort die in TXT wordt geadverteerd (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publiceert een MagicDNS‑hint in TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` overschrijft het geadverteerde CLI‑pad (legacy: `OPENCLAW_CLI_PATH`).

## Gerelateerde documentatie

- Discovery‑beleid en transportselectie: [Discovery](/gateway/discovery)
- Node‑koppeling + goedkeuringen: [Gateway pairing](/gateway/pairing)
