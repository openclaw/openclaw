---
summary: "Runbook para sa serbisyo ng Gateway, lifecycle, at mga operasyon"
read_when:
  - Kapag pinapatakbo o dini-debug ang proseso ng gateway
title: "Gateway Runbook"
x-i18n:
  source_path: gateway/index.md
  source_hash: e59d842824f892f6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:08Z
---

# Gateway service runbook

Huling na-update: 2025-12-09

## Ano ito

- Ang laging tumatakbong proseso na may-ari ng iisang koneksyon ng Baileys/Telegram at ng control/event plane.
- Pinapalitan ang legacy na `gateway` na command. CLI entry point: `openclaw gateway`.
- Tumatakbo hanggang ihinto; lalabas na non-zero sa mga fatal error para i-restart ito ng supervisor.

## Paano patakbuhin (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Ang config hot reload ay nagmo-monitor ng `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`).
  - Default na mode: `gateway.reload.mode="hybrid"` (hot-apply ng mga ligtas na pagbabago, restart kapag kritikal).
  - Gumagamit ang hot reload ng in-process restart via **SIGUSR1** kapag kailangan.
  - I-disable gamit ang `gateway.reload.mode="off"`.
- Ibinabind ang WebSocket control plane sa `127.0.0.1:<port>` (default 18789).
- Ang parehong port ay nagsisilbi rin ng HTTP (control UI, hooks, A2UI). Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Nagsisimula ng Canvas file server bilang default sa `canvasHost.port` (default `18793`), na naghahain ng `http://<gateway-host>:18793/__openclaw__/canvas/` mula sa `~/.openclaw/workspace/canvas`. I-disable gamit ang `canvasHost.enabled=false` o `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Nagla-log sa stdout; gamitin ang launchd/systemd para panatilihing buhay at i-rotate ang mga log.
- I-pass ang `--verbose` para i-mirror ang debug logging (handshakes, req/res, events) mula sa log file papunta sa stdio kapag nagti-troubleshoot.
- Gumagamit ang `--force` ng `lsof` para hanapin ang mga listener sa napiling port, nagpapadala ng SIGTERM, nagla-log kung ano ang pinatay, pagkatapos ay sinisimulan ang gateway (mabilis na bumibigo kung wala ang `lsof`).
- Kung tumatakbo sa ilalim ng supervisor (launchd/systemd/mac app child-process mode), ang stop/restart ay karaniwang nagpapadala ng **SIGTERM**; ang mga mas lumang build ay maaaring ipakita ito bilang `pnpm` `ELIFECYCLE` exit code **143** (SIGTERM), na isang normal na shutdown, hindi crash.
- Ang **SIGUSR1** ay nagti-trigger ng in-process restart kapag awtorisado (gateway tool/config apply/update, o i-enable ang `commands.restart` para sa manual restarts).
- Kailangan ang Gateway auth bilang default: itakda ang `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) o `gateway.auth.password`. Dapat magpadala ang mga client ng `connect.params.auth.token/password` maliban kung gumagamit ng Tailscale Serve identity.
- Ang wizard ay gumagawa na ngayon ng token bilang default, kahit sa loopback.
- Port precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.

## Remote access

- Mas mainam ang Tailscale/VPN; kung hindi, SSH tunnel:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Pagkatapos, kumokonekta ang mga client sa `ws://127.0.0.1:18789` sa pamamagitan ng tunnel.
- Kung may naka-configure na token, dapat isama ito ng mga client sa `connect.params.auth.token` kahit sa pamamagitan ng tunnel.

## Maramihang gateway (iisang host)

Karaniwan ay hindi kailangan: kayang pagsilbihan ng isang Gateway ang maraming messaging channel at agent. Gumamit lamang ng maraming Gateway para sa redundancy o mahigpit na isolation (hal: rescue bot).

Sinusuportahan kung ihiwalay ang state + config at gumamit ng natatanging mga port. Buong gabay: [Multiple gateways](/gateway/multiple-gateways).

Ang mga pangalan ng serbisyo ay profile-aware:

- macOS: `bot.molt.<profile>` (maaaring umiiral pa ang legacy `com.openclaw.*`)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Ang install metadata ay naka-embed sa service config:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: panatilihin ang pangalawang Gateway na hiwalay na may sariling profile, state dir, workspace, at base port spacing. Buong gabay: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Dev profile (`--dev`)

Mabilis na ruta: patakbuhin ang ganap na hiwalay na dev instance (config/state/workspace) nang hindi naaapektuhan ang iyong primary setup.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Mga default (maaaring i-override via env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- browser control service port = `19003` (derived: `gateway.port+2`, loopback lang)
- `canvasHost.port=19005` (derived: `gateway.port+4`)
- Ang default na `agents.defaults.workspace` ay nagiging `~/.openclaw/workspace-dev` kapag pinatakbo mo ang `setup`/`onboard` sa ilalim ng `--dev`.

Derived ports (mga panuntunang pangkalahatan):

- Base port = `gateway.port` (o `OPENCLAW_GATEWAY_PORT` / `--port`)
- browser control service port = base + 2 (loopback lang)
- `canvasHost.port = base + 4` (o `OPENCLAW_CANVAS_HOST_PORT` / config override)
- Ang Browser profile CDP ports ay auto-allocate mula sa `browser.controlPort + 9 .. + 108` (na pini-persist kada profile).

Checklist kada instance:

- natatanging `gateway.port`
- natatanging `OPENCLAW_CONFIG_PATH`
- natatanging `OPENCLAW_STATE_DIR`
- natatanging `agents.defaults.workspace`
- hiwalay na mga numero ng WhatsApp (kung gumagamit ng WA)

Service install kada profile:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Halimbawa:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocol (pananaw ng operator)

- Buong docs: [Gateway protocol](/gateway/protocol) at [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Mandatory na unang frame mula sa client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Sumasagot ang Gateway ng `res {type:"res", id, ok:true, payload:hello-ok }` (o `ok:false` na may error, pagkatapos ay magsasara).
- Pagkatapos ng handshake:
  - Mga request: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Mga event: `{type:"event", event, payload, seq?, stateVersion?}`
- Mga structured presence entry: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (para sa WS clients, ang `instanceId` ay nagmumula sa `connect.client.instanceId`).
- Ang mga `agent` na response ay two-stage: una ang `res` ack `{runId,status:"accepted"}`, pagkatapos ay ang final na `res` `{runId,status:"ok"|"error",summary}` matapos matapos ang run; dumarating ang streamed output bilang `event:"agent"`.

## Mga method (paunang set)

- `health` — buong health snapshot (kaparehong hugis ng `openclaw health --json`).
- `status` — maikling buod.
- `system-presence` — kasalukuyang listahan ng presence.
- `system-event` — mag-post ng presence/system note (structured).
- `send` — magpadala ng mensahe sa pamamagitan ng aktibong channel(s).
- `agent` — magpatakbo ng agent turn (nag-i-stream ng mga event pabalik sa parehong koneksyon).
- `node.list` — ilista ang paired + kasalukuyang nakakonektang mga node (kasama ang `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, at ina-advertise na `commands`).
- `node.describe` — ilarawan ang isang node (capabilities + sinusuportahang `node.invoke` commands; gumagana para sa mga paired node at para sa kasalukuyang nakakonektang unpaired node).
- `node.invoke` — i-invoke ang isang command sa isang node (hal. `canvas.*`, `camera.*`).
- `node.pair.*` — lifecycle ng pairing (`request`, `list`, `approve`, `reject`, `verify`).

Tingnan din: [Presence](/concepts/presence) para sa kung paano ginagawa/dinededup ang presence at kung bakit mahalaga ang isang stable na `client.instanceId`.

## Mga event

- `agent` — mga streamed tool/output event mula sa agent run (may seq-tag).
- `presence` — mga update sa presence (mga delta na may stateVersion) na itinutulak sa lahat ng nakakonektang client.
- `tick` — periodic keepalive/no-op para kumpirmahin ang pagiging buhay.
- `shutdown` — lalabas na ang Gateway; kasama sa payload ang `reason` at opsyonal na `restartExpectedMs`. Dapat mag-reconnect ang mga client.

## WebChat integration

- Ang WebChat ay isang native na SwiftUI UI na direktang nakikipag-usap sa Gateway WebSocket para sa history, sends, abort, at mga event.
- Ang remote na paggamit ay dumadaan sa parehong SSH/Tailscale tunnel; kung may naka-configure na gateway token, isinasama ito ng client sa panahon ng `connect`.
- Ang macOS app ay kumokonekta sa iisang WS (shared connection); hini-hydrate nito ang presence mula sa initial snapshot at nakikinig sa mga `presence` event para i-update ang UI.

## Typing at validation

- Vine-validate ng server ang bawat inbound frame gamit ang AJV laban sa JSON Schema na inilalabas mula sa mga protocol definition.
- Ang mga client (TS/Swift) ay kumokonsumo ng mga generated type (TS direkta; Swift via generator ng repo).
- Ang mga protocol definition ang source of truth; i-regenerate ang schema/models gamit ang:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Connection snapshot

- Ang `hello-ok` ay may kasamang `snapshot` na may `presence`, `health`, `stateVersion`, at `uptimeMs` kasama ang `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` para makapag-render agad ang mga client nang walang dagdag na request.
- Ang `health`/`system-presence` ay nananatiling available para sa manual refresh, ngunit hindi kailangan sa oras ng connect.

## Mga error code (res.error shape)

- Gumagamit ang mga error ng `{ code, message, details?, retryable?, retryAfterMs? }`.
- Mga standard na code:
  - `NOT_LINKED` — hindi authenticated ang WhatsApp.
  - `AGENT_TIMEOUT` — hindi tumugon ang agent sa loob ng naka-configure na deadline.
  - `INVALID_REQUEST` — nabigo ang schema/param validation.
  - `UNAVAILABLE` — nagsa-shutdown ang Gateway o hindi available ang isang dependency.

## Keepalive behavior

- Ang mga `tick` event (o WS ping/pong) ay inilalabas nang pana-panahon para malaman ng mga client na buhay ang Gateway kahit walang trapiko.
- Ang mga send/agent acknowledgement ay hiwalay na mga response; huwag i-overload ang ticks para sa sends.

## Replay / gaps

- Hindi nire-replay ang mga event. Nadidetect ng mga client ang mga seq gap at dapat mag-refresh (`health` + `system-presence`) bago magpatuloy. Ang WebChat at mga macOS client ay awtomatikong nagre-refresh kapag may gap.

## Supervision (halimbawa sa macOS)

- Gamitin ang launchd para panatilihing buhay ang serbisyo:
  - Program: path patungo sa `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: mga path ng file o `syslog`
- Sa failure, nire-restart ng launchd; ang fatal na misconfig ay dapat magpatuloy sa pag-exit para mapansin ng operator.
- Ang LaunchAgents ay per-user at nangangailangan ng naka-log in na session; para sa headless setups gumamit ng custom LaunchDaemon (hindi shipped).
  - Ang `openclaw gateway install` ay nagsusulat ng `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (o `bot.molt.<profile>.plist`; nililinis ang legacy na `com.openclaw.*`).
  - Ang `openclaw doctor` ay nag-audit ng LaunchAgent config at maaaring i-update ito sa kasalukuyang mga default.

## Pamamahala ng Gateway service (CLI)

Gamitin ang Gateway CLI para sa install/start/stop/restart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Mga tala:

- Ang `gateway status` ay nagpo-probe ng Gateway RPC bilang default gamit ang resolved port/config ng serbisyo (i-override gamit ang `--url`).
- Ang `gateway status --deep` ay nagdadagdag ng system-level scans (LaunchDaemons/system units).
- Ang `gateway status --no-probe` ay nilalaktawan ang RPC probe (kapaki-pakinabang kapag down ang networking).
- Ang `gateway status --json` ay stable para sa mga script.
- Ang `gateway status` ay nag-uulat ng **supervisor runtime** (tumatakbo ang launchd/systemd) nang hiwalay sa **RPC reachability** (WS connect + status RPC).
- Ang `gateway status` ay nagpi-print ng config path + probe target para maiwasan ang kalituhan ng “localhost vs LAN bind” at profile mismatches.
- Ang `gateway status` ay nagsasama ng huling gateway error line kapag mukhang tumatakbo ang serbisyo ngunit sarado ang port.
- Ang `logs` ay nagta-tail ng Gateway file log via RPC (hindi na kailangan ang manual na `tail`/`grep`).
- Kung may natukoy na ibang gateway-like services, magbibigay ng babala ang CLI maliban kung mga OpenClaw profile service ang mga iyon.
  Inirerekomenda pa rin namin ang **isang gateway bawat makina** para sa karamihan ng setup; gumamit ng hiwalay na mga profile/port para sa redundancy o rescue bot. Tingnan ang [Multiple gateways](/gateway/multiple-gateways).
  - Cleanup: `openclaw gateway uninstall` (kasalukuyang serbisyo) at `openclaw doctor` (legacy migrations).
- Ang `gateway install` ay no-op kapag naka-install na; gamitin ang `openclaw gateway install --force` para mag-reinstall (mga pagbabago sa profile/env/path).

Bundled mac app:

- Maaaring i-bundle ng OpenClaw.app ang isang Node-based gateway relay at mag-install ng per-user LaunchAgent na may label na
  `bot.molt.gateway` (o `bot.molt.<profile>`; ang mga legacy na `com.openclaw.*` label ay malinis na na-unload).
- Para ihinto nang maayos, gamitin ang `openclaw gateway stop` (o `launchctl bootout gui/$UID/bot.molt.gateway`).
- Para mag-restart, gamitin ang `openclaw gateway restart` (o `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - Ang `launchctl` ay gumagana lamang kung naka-install ang LaunchAgent; kung hindi, gamitin muna ang `openclaw gateway install`.
  - Palitan ang label ng `bot.molt.<profile>` kapag nagpapatakbo ng named profile.

## Supervision (systemd user unit)

Nag-i-install ang OpenClaw ng **systemd user service** bilang default sa Linux/WSL2. Inirerekomenda namin ang mga user service para sa mga single-user na makina (mas simpleng env, per-user config).
Gumamit ng **system service** para sa multi-user o always-on na mga server (walang lingering na kailangan, shared supervision).

Ang `openclaw gateway install` ay nagsusulat ng user unit. Ang `openclaw doctor` ay nag-audit ng
unit at maaaring i-update ito para tumugma sa kasalukuyang inirerekomendang mga default.

Gumawa ng `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

I-enable ang lingering (kailangan para mabuhay ang user service kahit mag-logout/idle):

```
sudo loginctl enable-linger youruser
```

Pinapatakbo ito ng onboarding sa Linux/WSL2 (maaaring mag-prompt para sa sudo; nagsusulat ng `/var/lib/systemd/linger`).
Pagkatapos, i-enable ang serbisyo:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternatibo (system service)** — para sa always-on o multi-user na mga server, maaari kang mag-install ng systemd **system** unit sa halip na user unit (walang lingering na kailangan).
Gumawa ng `/etc/systemd/system/openclaw-gateway[-<profile>].service` (kopyahin ang unit sa itaas,
palitan ang `WantedBy=multi-user.target`, itakda ang `User=` + `WorkingDirectory=`), pagkatapos ay:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Ang mga install sa Windows ay dapat gumamit ng **WSL2** at sundin ang seksyon ng Linux systemd sa itaas.

## Operational checks

- Liveness: buksan ang WS at magpadala ng `req:connect` → asahan ang `res` na may `payload.type="hello-ok"` (na may snapshot).
- Readiness: tawagin ang `health` → asahan ang `ok: true` at isang naka-link na channel sa `linkChannel` (kapag naaangkop).
- Debug: mag-subscribe sa mga `tick` at `presence` event; tiyaking ipinapakita ng `status` ang linked/auth age; ipinapakita ng mga presence entry ang host ng Gateway at mga nakakonektang client.

## Mga garantiya sa kaligtasan

- Ipagpalagay ang isang Gateway bawat host bilang default; kung nagpapatakbo ng maraming profile, ihiwalay ang mga port/state at i-target ang tamang instance.
- Walang fallback sa direktang koneksyon ng Baileys; kung down ang Gateway, mabilis na babagsak ang mga send.
- Ang mga non-connect first frame o malformed JSON ay tinatanggihan at isinasara ang socket.
- Maayos na shutdown: mag-emit ng `shutdown` event bago magsara; dapat hawakan ng mga client ang close + reconnect.

## Mga helper ng CLI

- `openclaw gateway health|status` — humiling ng health/status sa Gateway WS.
- `openclaw message send --target <num> --message "hi" [--media ...]` — magpadala sa pamamagitan ng Gateway (idempotent para sa WhatsApp).
- `openclaw agent --message "hi" --to <num>` — magpatakbo ng agent turn (naghihintay ng final bilang default).
- `openclaw gateway call <method> --params '{"k":"v"}'` — raw method invoker para sa debugging.
- `openclaw gateway stop|restart` — ihinto/i-restart ang supervised gateway service (launchd/systemd).
- Ipinagpapalagay ng mga helper subcommand ng Gateway na may tumatakbong gateway sa `--url`; hindi na sila awtomatikong nag-i-spawn ng isa.

## Gabay sa migration

- I-retire ang paggamit ng `openclaw gateway` at ng legacy TCP control port.
- I-update ang mga client para magsalita ng WS protocol na may mandatory connect at structured presence.
