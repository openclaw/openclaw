---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — patakbuhin, i-query, at i-discover ang mga gateway"
read_when:
  - Pagpapatakbo ng Gateway mula sa CLI (dev o servers)
  - Pag-debug ng auth, bind modes, at connectivity ng Gateway
  - Pag-discover ng mga gateway sa pamamagitan ng Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Ang Gateway ay ang WebSocket server ng OpenClaw (mga channel, node, session, hook).

Ang mga subcommand sa pahinang ito ay nasa ilalim ng `openclaw gateway …`.

Kaugnay na docs:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Patakbuhin ang Gateway

Magpatakbo ng lokal na Gateway process:

```bash
openclaw gateway
```

Foreground alias:

```bash
openclaw gateway run
```

Mga tala:

- 14. Bilang default, tatanggi ang Gateway na magsimula maliban kung ang `gateway.mode=local` ay nakatakda sa `~/.openclaw/openclaw.json`. 15. Gamitin ang `--allow-unconfigured` para sa mga ad-hoc/dev na run.
- Ang pag-bind lampas sa loopback nang walang auth ay naka-block (safety guardrail).
- Ang `SIGUSR1` ay nagti-trigger ng in-process restart kapag authorized (i-enable ang `commands.restart` o gamitin ang gateway tool/config apply/update).
- 16. Ang mga `SIGINT`/`SIGTERM` handler ay humihinto sa proseso ng gateway, ngunit hindi nila ibinabalik ang anumang custom na estado ng terminal. 17. Kung binabalot mo ang CLI gamit ang isang TUI o raw-mode input, ibalik ang terminal bago lumabas.

### Mga opsyon

- `--port <port>`: WebSocket port (ang default ay galing sa config/env; karaniwan ay `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind mode.
- `--auth <token|password>`: auth mode override.
- `--token <token>`: token override (ini-set din ang `OPENCLAW_GATEWAY_TOKEN` para sa process).
- `--password <password>`: password override (ini-set din ang `OPENCLAW_GATEWAY_PASSWORD` para sa process).
- `--tailscale <off|serve|funnel>`: i-expose ang Gateway via Tailscale.
- `--tailscale-reset-on-exit`: i-reset ang Tailscale serve/funnel config sa shutdown.
- `--allow-unconfigured`: payagan ang pagsisimula ng gateway kahit walang `gateway.mode=local` sa config.
- `--dev`: lumikha ng dev config + workspace kung wala (nilalaktawan ang BOOTSTRAP.md).
- `--reset`: i-reset ang dev config + credentials + sessions + workspace (nangangailangan ng `--dev`).
- `--force`: patayin ang anumang umiiral na listener sa napiling port bago magsimula.
- `--verbose`: verbose logs.
- `--claude-cli-logs`: ipakita lang ang mga log ng claude-cli sa console (at i-enable ang stdout/stderr nito).
- `--ws-log <auto|full|compact>`: websocket log style (default `auto`).
- `--compact`: alias para sa `--ws-log compact`.
- `--raw-stream`: i-log ang raw model stream events sa jsonl.
- `--raw-stream-path <path>`: raw stream jsonl path.

## I-query ang tumatakbong Gateway

Lahat ng query command ay gumagamit ng WebSocket RPC.

Mga output mode:

- Default: human-readable (may kulay sa TTY).
- `--json`: machine-readable JSON (walang styling/spinner).
- `--no-color` (o `NO_COLOR=1`): i-disable ang ANSI habang pinananatili ang human layout.

Mga shared na opsyon (kung supported):

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway token.
- `--password <password>`: Gateway password.
- `--timeout <ms>`: timeout/budget (nag-iiba-iba kada command).
- `--expect-final`: maghintay ng “final” na response (agent calls).

18. Paalala: kapag itinakda mo ang `--url`, hindi na babalik ang CLI sa config o mga credential mula sa environment.
19. Ipasa nang tahasan ang `--token` o `--password`. 20. Ang kakulangan ng tahasang credential ay isang error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

Ipinapakita ng `gateway status` ang Gateway service (launchd/systemd/schtasks) kasama ang opsyonal na RPC probe.

```bash
openclaw gateway status
openclaw gateway status --json
```

Mga opsyon:

- `--url <url>`: i-override ang probe URL.
- `--token <token>`: token auth para sa probe.
- `--password <password>`: password auth para sa probe.
- `--timeout <ms>`: probe timeout (default `10000`).
- `--no-probe`: laktawan ang RPC probe (service-only na view).
- `--deep`: i-scan din ang system-level services.

### `gateway probe`

21. Ang `gateway probe` ang utos na “i-debug ang lahat”. 22. Palagi nitong sinusuri:

- ang naka-configure mong remote gateway (kung naka-set), at
- ang localhost (loopback) **kahit naka-configure ang remote**.

23. Kung maraming gateway ang maaabot, ipi-print nito ang lahat ng mga iyon. 24. Sinusuportahan ang maraming gateway kapag gumagamit ka ng mga isolated na profile/port (hal., isang rescue bot), ngunit karamihan sa mga install ay nagpapatakbo pa rin ng iisang gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remote over SSH (Mac app parity)

Ang macOS app na “Remote over SSH” mode ay gumagamit ng lokal na port-forward para maging naaabot ang remote gateway (na maaaring naka-bind lang sa loopback) sa `ws://127.0.0.1:<port>`.

Katumbas sa CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Mga opsyon:

- `--ssh <target>`: `user@host` o `user@host:port` (ang port ay default sa `22`).
- `--ssh-identity <path>`: identity file.
- `--ssh-auto`: piliin ang unang nadiskubreng host ng gateway bilang SSH target (LAN/WAB lamang).

Config (opsyonal, ginagamit bilang mga default):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level na RPC helper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Pamahalaan ang Gateway service

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Mga tala:

- Sinusuportahan ng `gateway install` ang `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Tumatanggap ang mga lifecycle command ng `--json` para sa scripting.

## I-discover ang mga gateway (Bonjour)

Ang `gateway discover` ay nag-scan para sa mga Gateway beacon (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): pumili ng domain (halimbawa: `openclaw.internal.`) at mag-set up ng split DNS + isang DNS server; tingnan ang [/gateway/bonjour](/gateway/bonjour)

Tanging mga gateway na may naka-enable na Bonjour discovery (default) ang nag-a-advertise ng beacon.

Kasama sa Wide-Area discovery records ang (TXT):

- `role` (hint ng role ng gateway)
- 25. `transport` (transport hint, hal. `gateway`)
- `gatewayPort` (WebSocket port, karaniwang `18789`)
- `sshPort` (SSH port; default sa `22` kung wala)
- `tailnetDns` (MagicDNS hostname, kapag available)
- `gatewayTls` / `gatewayTlsSha256` (naka-enable ang TLS + cert fingerprint)
- `cliPath` (opsyonal na hint para sa remote installs)

### `gateway discover`

```bash
openclaw gateway discover
```

Mga opsyon:

- `--timeout <ms>`: per-command timeout (browse/resolve); default `2000`.
- `--json`: machine-readable na output (ini-disable din ang styling/spinner).

Mga halimbawa:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
