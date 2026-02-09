---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — kør, forespørg og opdag gateways"
read_when:
  - Kørsel af Gateway fra CLI (dev eller servere)
  - Fejlfinding af Gateway-autentificering, bind-tilstande og forbindelser
  - Opdagelse af gateways via Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway er OpenClaws WebSocket-server (kanaler, noder, sessioner, hooks).

Underkommandoer på denne side ligger under `openclaw gateway …`.

Relaterede docs:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Kør Gateway

Kør en lokal Gateway-proces:

```bash
openclaw gateway
```

Forgrunds-alias:

```bash
openclaw gateway run
```

Noter:

- Som standard nægter Gateway at starte medmindre `gateway.mode=local` er sat i `~/.openclaw/openclaw.json`. Brug `-- allow-unconfigured` til ad-hoc/dev kører.
- Binding ud over loopback uden auth er blokeret (sikkerheds-guardrail).
- `SIGUSR1` udløser en genstart i processen, når autoriseret (aktivér `commands.restart` eller brug gateway-værktøjet/config apply/update).
- `SIGINT`/`SIGTERM` handlere stoppe gateway proces, men de gendanner ikke nogen brugerdefineret terminaltilstand. Hvis du ombryder CLI med en TUI eller rå tilstand input, gendan terminalen før du afslutter.

### Indstillinger

- `--port <port>`: WebSocket-port (standard kommer fra config/env; normalt `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: lytterens bind-tilstand.
- `--auth <token|password>`: tilsidesættelse af auth-tilstand.
- `--token <token>`: tilsidesættelse af token (sætter også `OPENCLAW_GATEWAY_TOKEN` for processen).
- `--password <password>`: tilsidesættelse af adgangskode (sætter også `OPENCLAW_GATEWAY_PASSWORD` for processen).
- `--tailscale <off|serve|funnel>`: eksponér Gateway via Tailscale.
- `--tailscale-reset-on-exit`: nulstil Tailscale serve/funnel-konfiguration ved nedlukning.
- `--allow-unconfigured`: tillad gateway-start uden `gateway.mode=local` i config.
- `--dev`: opret en dev-config + workspace, hvis de mangler (springer BOOTSTRAP.md over).
- `--reset`: nulstil dev-config + legitimationsoplysninger + sessioner + workspace (kræver `--dev`).
- `--force`: dræb enhver eksisterende lytter på den valgte port før start.
- `--verbose`: udførlige logs.
- `--claude-cli-logs`: vis kun claude-cli-logs i konsollen (og aktivér dens stdout/stderr).
- `--ws-log <auto|full|compact>`: websocket-logstil (standard `auto`).
- `--compact`: alias for `--ws-log compact`.
- `--raw-stream`: log rå model-stream-events til jsonl.
- `--raw-stream-path <path>`: sti til raw stream jsonl.

## Forespørg en kørende Gateway

Alle forespørgselskommandoer bruger WebSocket RPC.

Output-tilstande:

- Standard: menneskelæsbart (farvet i TTY).
- `--json`: maskinlæsbart JSON (ingen styling/spinner).
- `--no-color` (eller `NO_COLOR=1`): deaktivér ANSI, mens det menneskelige layout bevares.

Delte indstillinger (hvor understøttet):

- `--url <url>`: Gateway WebSocket-URL.
- `--token <token>`: Gateway-token.
- `--password <password>`: Gateway-adgangskode.
- `--timeout <ms>`: timeout/budget (varierer pr. kommando).
- `--expect-final`: vent på et “final”-svar (agentkald).

Bemærk: Når du angiver `--url`, falder CLI ikke tilbage til config eller miljø legitimationsoplysninger.
Pass `--token` eller `--password` eksplicitt. Manglende eksplicitte legitimationsoplysninger er en fejl.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` viser Gateway-tjenesten (launchd/systemd/schtasks) samt en valgfri RPC-probe.

```bash
openclaw gateway status
openclaw gateway status --json
```

Indstillinger:

- `--url <url>`: tilsidesæt probe-URL’en.
- `--token <token>`: token-auth for proben.
- `--password <password>`: password-auth for proben.
- `--timeout <ms>`: probe-timeout (standard `10000`).
- `--no-probe`: spring RPC-proben over (kun tjenestevisning).
- `--deep`: scan også systemniveau-tjenester.

### `gateway probe`

`gateway sonde` er kommandoen “debug everything”. Det altid sonder:

- din konfigurerede remote gateway (hvis sat), og
- localhost (loopback) **selv hvis remote er konfigureret**.

Hvis flere gateways er tilgængelige, udskriver det dem alle. Flere gateways understøttes, når du bruger isolerede profiler/porte (f.eks. en rescue bot), men de fleste installerer stadig en enkelt gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remote over SSH (macOS-app-paritet)

macOS-appen i tilstanden “Remote over SSH” bruger en lokal port-forward, så den remote gateway (som kan være bundet kun til loopback) bliver tilgængelig på `ws://127.0.0.1:<port>`.

CLI-ækvivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Indstillinger:

- `--ssh <target>`: `user@host` eller `user@host:port` (porten er som standard `22`).
- `--ssh-identity <path>`: identitetsfil.
- `--ssh-auto`: vælg den første opdagede gateway-vært som SSH-mål (kun LAN/WAB).

Config (valgfri, bruges som standarder):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Lav-niveau RPC-hjælper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Administrér Gateway-tjenesten

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Noter:

- `gateway install` understøtter `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Livscykluskommandoer accepterer `--json` til scripting.

## Opdag gateways (Bonjour)

`gateway discover` scanner efter Gateway-beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): vælg et domæne (eksempel: `openclaw.internal.`) og opsæt split DNS + en DNS-server; se [/gateway/bonjour](/gateway/bonjour)

Kun gateways med Bonjour-discovery aktiveret (standard) annoncerer beaconet.

Wide-Area discovery-poster inkluderer (TXT):

- `role` (gateway-rollehint)
- `transport` (transporthint, fx `gateway`)
- `gatewayPort` (WebSocket-port, normalt `18789`)
- `sshPort` (SSH-port; standard er `22`, hvis ikke angivet)
- `tailnetDns` (MagicDNS-værtsnavn, når tilgængeligt)
- `gatewayTls` / `gatewayTlsSha256` (TLS aktiveret + cert-fingeraftryk)
- `cliPath` (valgfrit hint for remote-installationer)

### `gateway discover`

```bash
openclaw gateway discover
```

Indstillinger:

- `--timeout <ms>`: timeout pr. kommando (browse/resolve); standard `2000`.
- `--json`: maskinlæsbart output (deaktiverer også styling/spinner).

Eksempler:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
