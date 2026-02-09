---
summary: "Bonjour/mDNS discovery + pag-debug (Gateway beacons, clients, at mga karaniwang failure mode)"
read_when:
  - Pag-debug ng mga isyu sa Bonjour discovery sa macOS/iOS
  - Pagbabago ng mga uri ng mDNS service, TXT records, o discovery UX
title: "Bonjour Discovery"
---

# Bonjour / mDNS discovery

Gumagamit ang OpenClaw ng Bonjour (mDNS / DNS‑SD) bilang isang **LAN‑only na kaginhawaan** upang matuklasan ang isang aktibong Gateway (WebSocket endpoint). Ito ay best‑effort at **hindi** pumapalit sa SSH o Tailnet‑based connectivity.

## Wide‑area Bonjour (Unicast DNS‑SD) sa ibabaw ng Tailscale

Kung ang node at gateway ay nasa magkaibang network, hindi tatawid ang multicast mDNS sa hangganan. Maaari mong panatilihin ang parehong discovery UX sa pamamagitan ng paglipat sa **unicast DNS‑SD** ("Wide‑Area Bonjour") sa ibabaw ng Tailscale.

High‑level na mga hakbang:

1. Magpatakbo ng DNS server sa host ng Gateway (naaabot sa Tailnet).
2. Mag-publish ng DNS‑SD records para sa `_openclaw-gw._tcp` sa ilalim ng isang dedicated zone
   (halimbawa: `openclaw.internal.`).
3. I-configure ang Tailscale **split DNS** para ang napili mong domain ay mag-resolve sa DNS server na iyon
   para sa mga client (kasama ang iOS).

Sinusuportahan ng OpenClaw ang anumang discovery domain; halimbawa lamang ang `openclaw.internal.`.
Nagba‑browse ang mga iOS/Android node sa parehong `local.` at sa iyong naka‑configure na wide‑area domain.

### Gateway config (inirerekomenda)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### One‑time na setup ng DNS server (host ng Gateway)

```bash
openclaw dns setup --apply
```

Ini-install nito ang CoreDNS at kino-configure ito para:

- makinig sa port 53 lamang sa mga Tailscale interface ng Gateway
- mag-serve ng napili mong domain (halimbawa: `openclaw.internal.`) mula sa `~/.openclaw/dns/<domain>.db`

I-validate mula sa isang machine na nakakonekta sa tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Mga setting ng Tailscale DNS

Sa Tailscale admin console:

- Magdagdag ng nameserver na tumuturo sa tailnet IP ng Gateway (UDP/TCP 53).
- Magdagdag ng split DNS para ang iyong discovery domain ay gumamit ng nameserver na iyon.

Kapag tinanggap na ng mga client ang tailnet DNS, makaka-browse ang mga iOS node ng
`_openclaw-gw._tcp` sa iyong discovery domain nang walang multicast.

### Seguridad ng Gateway listener (inirerekomenda)

Ang Gateway WS port (default `18789`) ay nagba‑bind sa loopback bilang default. Para sa LAN/tailnet access, mag‑bind nang tahasan at panatilihing naka‑enable ang auth.

Para sa tailnet‑only na mga setup:

- Itakda ang `gateway.bind: "tailnet"` sa `~/.openclaw/openclaw.json`.
- I-restart ang Gateway (o i-restart ang macOS menubar app).

## Ano ang nag-a-advertise

Gateway lang ang nag-a-advertise ng `_openclaw-gw._tcp`.

## Mga uri ng service

- `_openclaw-gw._tcp` — gateway transport beacon (ginagamit ng mga macOS/iOS/Android node).

## Mga TXT key (hindi lihim na mga hint)

Nag-a-advertise ang Gateway ng maliliit at hindi lihim na mga hint para gawing maginhawa ang UI flows:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (kapag naka-enable lang ang TLS)
- `gatewayTlsSha256=<sha256>` (kapag naka-enable ang TLS at may available na fingerprint)
- `canvasPort=<port>` (kapag naka-enable ang canvas host; default `18793`)
- `sshPort=<port>` (nagde-default sa 22 kapag hindi na-override)
- `transport=gateway`
- `cliPath=<path>` (opsyonal; absolute path sa isang runnable na `openclaw` entrypoint)
- `tailnetDns=<magicdns>` (opsyonal na hint kapag available ang Tailnet)

## Pag-debug sa macOS

Mga kapaki-pakinabang na built‑in na tool:

- Mag-browse ng mga instance:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- I-resolve ang isang instance (palitan ang `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Kung gumagana ang browsing pero pumapalya ang resolving, kadalasan ay LAN policy o
mDNS resolver issue ang tinatamaan mo.

## Pag-debug sa mga log ng Gateway

Nagsusulat ang Gateway ng rolling log file (ipinapakita sa startup bilang `gateway log file: ...`). Hanapin ang mga linyang `bonjour:`, lalo na:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Pag-debug sa iOS node

Ginagamit ng iOS node ang `NWBrowser` para ma-discover ang `_openclaw-gw._tcp`.

Para kumuha ng mga log:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → mag-reproduce → **Copy**

Kasama sa log ang mga browser state transition at mga pagbabago sa result‑set.

## Mga karaniwang failure mode

- **Hindi tumatawid ang Bonjour sa mga network**: gumamit ng Tailnet o SSH.
- **Naka-block ang multicast**: may ilang Wi‑Fi network na dini-disable ang mDNS.
- **Sleep / interface churn**: maaaring pansamantalang mag-drop ng mDNS results ang macOS; subukang muli.
- **Gumagana ang browse ngunit pumapalya ang resolve**: panatilihing simple ang mga pangalan ng makina (iwasan ang mga emoji o bantas), pagkatapos ay i‑restart ang Gateway. Nagmumula ang service instance name sa host name, kaya ang mga sobrang komplikadong pangalan ay maaaring makalito sa ilang resolver.

## Mga escaped na instance name (`\032`)

Madalas i-escape ng Bonjour/DNS‑SD ang mga byte sa service instance name bilang decimal na `\DDD`
sequences (hal. ang mga space ay nagiging `\032`).

- Normal ito sa antas ng protocol.
- Dapat i-decode ng mga UI para sa display (gumagamit ang iOS ng `BonjourEscapes.decode`).

## Pag-disable / konpigurasyon

- Dina-disable ng `OPENCLAW_DISABLE_BONJOUR=1` ang advertising (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- Kinokontrol ng `gateway.bind` sa `~/.openclaw/openclaw.json` ang Gateway bind mode.
- Ino-override ng `OPENCLAW_SSH_PORT` ang SSH port na ina-advertise sa TXT (legacy: `OPENCLAW_SSH_PORT`).
- Nagpa-publish ang `OPENCLAW_TAILNET_DNS` ng MagicDNS hint sa TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- Ino-override ng `OPENCLAW_CLI_PATH` ang advertised na CLI path (legacy: `OPENCLAW_CLI_PATH`).

## Kaugnay na docs

- Discovery policy at pagpili ng transport: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
