---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — gateways uitvoeren, bevragen en ontdekken"
read_when:
  - De Gateway uitvoeren vanaf de CLI (dev of servers)
  - Gateway-authenticatie, bind-modi en connectiviteit debuggen
  - Gateways ontdekken via Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

De Gateway is de WebSocket-server van OpenClaw (kanalen, nodes, sessies, hooks).

Subopdrachten op deze pagina vallen onder `openclaw gateway …`.

Gerelateerde documentatie:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## De Gateway uitvoeren

Start een lokaal Gateway-proces:

```bash
openclaw gateway
```

Foreground-alias:

```bash
openclaw gateway run
```

Notities:

- Standaard weigert de Gateway te starten tenzij `gateway.mode=local` is ingesteld in `~/.openclaw/openclaw.json`. Gebruik `--allow-unconfigured` voor ad-hoc/dev-runs.
- Binden buiten loopback zonder authenticatie is geblokkeerd (veiligheidsvangrail).
- `SIGUSR1` triggert een herstart in het proces wanneer geautoriseerd (schakel `commands.restart` in of gebruik de gateway tool/config apply/update).
- `SIGINT`/`SIGTERM`-handlers stoppen het gateway-proces, maar herstellen geen aangepaste terminalstatus. Als je de CLI omwikkelt met een TUI of raw-mode invoer, herstel de terminal vóór afsluiten.

### Opties

- `--port <port>`: WebSocket-poort (standaard komt uit config/env; meestal `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind-modus.
- `--auth <token|password>`: override voor auth-modus.
- `--token <token>`: token-override (stelt ook `OPENCLAW_GATEWAY_TOKEN` in voor het proces).
- `--password <password>`: wachtwoord-override (stelt ook `OPENCLAW_GATEWAY_PASSWORD` in voor het proces).
- `--tailscale <off|serve|funnel>`: de Gateway blootstellen via Tailscale.
- `--tailscale-reset-on-exit`: Tailscale serve/funnel-config resetten bij afsluiten.
- `--allow-unconfigured`: gateway-start toestaan zonder `gateway.mode=local` in de config.
- `--dev`: een dev-config + werkruimte aanmaken indien ontbrekend (BOOTSTRAP.md overslaan).
- `--reset`: dev-config + credentials + sessies + werkruimte resetten (vereist `--dev`).
- `--force`: elke bestaande listener op de geselecteerde poort beëindigen vóór het starten.
- `--verbose`: uitgebreide logs.
- `--claude-cli-logs`: alleen claude-cli-logs in de console tonen (en stdout/stderr inschakelen).
- `--ws-log <auto|full|compact>`: websocket-logstijl (standaard `auto`).
- `--compact`: alias voor `--ws-log compact`.
- `--raw-stream`: ruwe model-streamgebeurtenissen loggen naar jsonl.
- `--raw-stream-path <path>`: pad voor ruwe stream-jsonl.

## Een draaiende Gateway bevragen

Alle query-opdrachten gebruiken WebSocket RPC.

Uitvoermodi:

- Standaard: leesbaar voor mensen (gekleurd in TTY).
- `--json`: machineleesbare JSON (geen styling/spinner).
- `--no-color` (of `NO_COLOR=1`): ANSI uitschakelen met behoud van de menselijke lay-out.

Gedeelde opties (waar ondersteund):

- `--url <url>`: Gateway WebSocket-URL.
- `--token <token>`: Gateway-token.
- `--password <password>`: Gateway-wachtwoord.
- `--timeout <ms>`: timeout/budget (varieert per opdracht).
- `--expect-final`: wachten op een “finale” respons (agent-calls).

Let op: wanneer je `--url` instelt, valt de CLI niet terug op config- of omgevingscredentials.
Geef `--token` of `--password` expliciet door. Ontbrekende expliciete credentials is een fout.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` toont de Gateway-service (launchd/systemd/schtasks) plus een optionele RPC-probe.

```bash
openclaw gateway status
openclaw gateway status --json
```

Opties:

- `--url <url>`: de probe-URL overschrijven.
- `--token <token>`: token-authenticatie voor de probe.
- `--password <password>`: wachtwoord-authenticatie voor de probe.
- `--timeout <ms>`: probe-timeout (standaard `10000`).
- `--no-probe`: de RPC-probe overslaan (alleen service-weergave).
- `--deep`: ook services op systeemniveau scannen.

### `gateway probe`

`gateway probe` is de “debug alles”-opdracht. Deze probeert altijd:

- je geconfigureerde externe gateway (indien ingesteld), en
- localhost (loopback) **zelfs als remote is geconfigureerd**.

Als meerdere gateways bereikbaar zijn, worden ze allemaal weergegeven. Meerdere gateways worden ondersteund wanneer je geïsoleerde profielen/poorten gebruikt (bijv. een rescue-bot), maar de meeste installaties draaien nog steeds één gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Op afstand via SSH (Mac-app-pariteit)

De macOS-appmodus “Remote over SSH” gebruikt een lokale port-forward zodat de externe gateway (die mogelijk alleen aan loopback is gebonden) bereikbaar wordt op `ws://127.0.0.1:<port>`.

CLI-equivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Opties:

- `--ssh <target>`: `user@host` of `user@host:port` (poort standaard `22`).
- `--ssh-identity <path>`: identity-bestand.
- `--ssh-auto`: kies de eerst ontdekte Gateway-host als SSH-doel (alleen LAN/WAB).

Config (optioneel, gebruikt als standaardwaarden):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC-helper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## De Gateway-service beheren

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notities:

- `gateway install` ondersteunt `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Lifecycle-opdrachten accepteren `--json` voor scripting.

## Gateways ontdekken (Bonjour)

`gateway discover` scant naar Gateway-beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): kies een domein (voorbeeld: `openclaw.internal.`) en stel split DNS + een DNS-server in; zie [/gateway/bonjour](/gateway/bonjour)

Alleen gateways met Bonjour-discovery ingeschakeld (standaard) adverteren de beacon.

Wide-Area discovery-records bevatten (TXT):

- `role` (gateway-rolhint)
- `transport` (transporthint, bijv. `gateway`)
- `gatewayPort` (WebSocket-poort, meestal `18789`)
- `sshPort` (SSH-poort; standaard `22` indien niet aanwezig)
- `tailnetDns` (MagicDNS-hostnaam, indien beschikbaar)
- `gatewayTls` / `gatewayTlsSha256` (TLS ingeschakeld + certificaatvingerafdruk)
- `cliPath` (optionele hint voor externe installaties)

### `gateway discover`

```bash
openclaw gateway discover
```

Opties:

- `--timeout <ms>`: timeout per opdracht (browse/resolve); standaard `2000`.
- `--json`: machineleesbare uitvoer (schakelt ook styling/spinner uit).

Voorbeelden:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
