---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — kör, fråga och upptäck gateways"
read_when:
  - Köra Gateway från CLI (utveckling eller servrar)
  - Felsöka Gateway-autentisering, bindningslägen och anslutning
  - Upptäcka gateways via Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway är OpenClaws WebSocket-server (kanaler, noder, sessioner, hooks).

Underkommandon på den här sidan ligger under `openclaw gateway …`.

Relaterad dokumentation:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Kör Gateway

Kör en lokal Gateway-process:

```bash
openclaw gateway
```

Alias för förgrundsläge:

```bash
openclaw gateway run
```

Noteringar:

- Som standard vägrar Gateway att starta om inte `gateway.mode=local` är satt i `~/.openclaw/openclaw.json`. Använd `--allow-unconfigured` för ad-hoc/dev körs.
- Bindning utanför loopback utan autentisering blockeras (säkerhetsräcke).
- `SIGUSR1` triggar en omstart i processen när den är auktoriserad (aktivera `commands.restart` eller använd gateway-verktyget/konfig apply/update).
- `SIGINT`/`SIGTERM`-hanterare stoppar gatewayprocessen, men de återställer inte något anpassat terminaltillstånd. Om du sveper in CLI med en TUI eller raw-mode ingång, återställ terminalen innan avfarten.

### Alternativ

- `--port <port>`: WebSocket-port (standard kommer från konfig/miljö; vanligtvis `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: lyssnarens bindningsläge.
- `--auth <token|password>`: åsidosättning av autentiseringsläge.
- `--token <token>`: åsidosättning av token (sätter även `OPENCLAW_GATEWAY_TOKEN` för processen).
- `--password <password>`: åsidosättning av lösenord (sätter även `OPENCLAW_GATEWAY_PASSWORD` för processen).
- `--tailscale <off|serve|funnel>`: exponera Gateway via Tailscale.
- `--tailscale-reset-on-exit`: återställ Tailscale serve/funnel-konfiguration vid nedstängning.
- `--allow-unconfigured`: tillåt start av gateway utan `gateway.mode=local` i konfig.
- `--dev`: skapa en utvecklingskonfig + workspace om det saknas (hoppar över BOOTSTRAP.md).
- `--reset`: återställ utvecklingskonfig + autentiseringsuppgifter + sessioner + workspace (kräver `--dev`).
- `--force`: döda eventuell befintlig lyssnare på vald port före start.
- `--verbose`: utförliga loggar.
- `--claude-cli-logs`: visa endast claude-cli-loggar i konsolen (och aktivera dess stdout/stderr).
- `--ws-log <auto|full|compact>`: stil för websocket-loggar (standard `auto`).
- `--compact`: alias för `--ws-log compact`.
- `--raw-stream`: logga råa modellström-händelser till jsonl.
- `--raw-stream-path <path>`: sökväg för raw stream jsonl.

## Fråga en körande Gateway

Alla frågekommandon använder WebSocket RPC.

Utdatalägen:

- Standard: läsbart för människor (färgat i TTY).
- `--json`: maskinläsbar JSON (ingen styling/spinner).
- `--no-color` (eller `NO_COLOR=1`): inaktivera ANSI men behåll mänsklig layout.

Delade alternativ (där de stöds):

- `--url <url>`: Gateway WebSocket-URL.
- `--token <token>`: Gateway-token.
- `--password <password>`: Gateway-lösenord.
- `--timeout <ms>`: timeout/budget (varierar per kommando).
- `--expect-final`: vänta på ett ”final”-svar (agentanrop).

Notera: När du anger `--url`, faller CLI inte tillbaka till config eller miljöuppgifter.
Passera `--token` eller` --lösenord` explicit. Saknar explicita referenser är ett fel.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` visar Gateway-tjänsten (launchd/systemd/schtasks) samt en valfri RPC-prob.

```bash
openclaw gateway status
openclaw gateway status --json
```

Alternativ:

- `--url <url>`: åsidosätt prob-URL.
- `--token <token>`: tokenautentisering för proben.
- `--password <password>`: lösenordsautentisering för proben.
- `--timeout <ms>`: prob-timeout (standard `10000`).
- `--no-probe`: hoppa över RPC-proben (endast tjänstvy).
- `--deep`: skanna även tjänster på systemnivå.

### `gateway probe`

`gateway probe` är kommandot ”debug everything”. Det alltid probes:

- din konfigurerade fjärr-gateway (om satt), och
- localhost (loopback) **även om fjärr är konfigurerad**.

Om flera gateways är nåbara, skriver det ut dem alla. Flera gateways stöds när du använder isolerade profiler/portar (t.ex. en räddningsbot), men de flesta installationer kör fortfarande en enda gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Fjärr över SSH (paritet med Mac-app)

macOS-appen i läget ”Remote over SSH” använder en lokal port-forward så att den fjärr-gateway (som kan vara bunden endast till loopback) blir nåbar på `ws://127.0.0.1:<port>`.

CLI-motsvarighet:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Alternativ:

- `--ssh <target>`: `user@host` eller `user@host:port` (porten standardiseras till `22`).
- `--ssh-identity <path>`: identitetsfil.
- `--ssh-auto`: välj den första upptäckta gateway-värden som SSH-mål (endast LAN/WAB).

Konfig (valfritt, används som standardvärden):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Lågnivå RPC-hjälpare.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Hantera Gateway-tjänsten

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Noteringar:

- `gateway install` stöder `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Livscykelkommandon accepterar `--json` för skriptning.

## Upptäck gateways (Bonjour)

`gateway discover` söker efter Gateway-beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): välj en domän (exempel: `openclaw.internal.`) och sätt upp split DNS + en DNS-server; se [/gateway/bonjour](/gateway/bonjour)

Endast gateways med Bonjour-upptäckt aktiverad (standard) annonserar beaconn.

Wide-Area discovery-poster inkluderar (TXT):

- `role` (gateway-rollhint)
- `transport` (transportledtråd, t.ex. `gateway`)
- `gatewayPort` (WebSocket-port, vanligtvis `18789`)
- `sshPort` (SSH-port; standard `22` om den inte finns)
- `tailnetDns` (MagicDNS-värdnamn, när tillgängligt)
- `gatewayTls` / `gatewayTlsSha256` (TLS aktiverat + certifikatets fingeravtryck)
- `cliPath` (valfri hint för fjärrinstallationer)

### `gateway discover`

```bash
openclaw gateway discover
```

Alternativ:

- `--timeout <ms>`: timeout per kommando (browse/resolve); standard `2000`.
- `--json`: maskinläsbar utdata (inaktiverar även styling/spinner).

Exempel:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
