---
summary: "Runbook voor de Gateway-service, levenscyclus en operations"
read_when:
  - Het Gateway-proces draaien of debuggen
title: "Gateway Runbook"
---

# Gateway service runbook

Laatst bijgewerkt: 2025-12-09

## Wat het is

- Het always-on proces dat de enkele Baileys/Telegram-verbinding en het control-/eventplane beheert.
- Vervangt het legacy `gateway`-commando. CLI-entrypoint: `openclaw gateway`.
- Draait totdat het wordt gestopt; sluit af met een niet-nul exitcode bij fatale fouten zodat de supervisor het herstart.

## Hoe te draaien (lokaal)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Config hot reload bewaakt `~/.openclaw/openclaw.json` (of `OPENCLAW_CONFIG_PATH`).
  - Standaardmodus: `gateway.reload.mode="hybrid"` (pas veilige wijzigingen hot toe, herstart bij kritisch).
  - Hot reload gebruikt een in-process herstart via **SIGUSR1** wanneer nodig.
  - Uitschakelen met `gateway.reload.mode="off"`.
- Bindt het WebSocket control plane aan `127.0.0.1:<port>` (standaard 18789).
- Dezelfde poort bedient ook HTTP (control UI, hooks, A2UI). Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Start standaard een Canvas-bestandsserver op `canvasHost.port` (standaard `18793`), die `http://<gateway-host>:18793/__openclaw__/canvas/` serveert vanuit `~/.openclaw/workspace/canvas`. Uitschakelen met `canvasHost.enabled=false` of `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Logt naar stdout; gebruik launchd/systemd om het proces draaiende te houden en logs te roteren.
- Geef `--verbose` mee om debuglogging (handshakes, req/res, events) uit het logbestand te spiegelen naar stdio bij het troubleshooten.
- `--force` gebruikt `lsof` om listeners op de gekozen poort te vinden, stuurt SIGTERM, logt wat is beëindigd en start daarna de gateway (faalt snel als `lsof` ontbreekt).
- Als je onder een supervisor draait (launchd/systemd/mac app child-process-modus), stuurt een stop/herstart doorgaans **SIGTERM**; oudere builds kunnen dit tonen als `pnpm` `ELIFECYCLE` exitcode **143** (SIGTERM), wat een normale shutdown is en geen crash.
- **SIGUSR1** triggert een in-process herstart wanneer geautoriseerd (gateway tool/config apply/update, of schakel `commands.restart` in voor handmatige herstarts).
- Gateway-authenticatie is standaard vereist: stel `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`) of `gateway.auth.password` in. Clients moeten `connect.params.auth.token/password` meesturen, tenzij ze Tailscale Serve identity gebruiken.
- De wizard genereert nu standaard een token, zelfs op loopback.
- Poortprecedentie: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > standaard `18789`.

## Externe toegang

- Tailscale/VPN heeft de voorkeur; anders een SSH-tunnel:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Clients verbinden vervolgens met `ws://127.0.0.1:18789` via de tunnel.

- Als een token is geconfigureerd, moeten clients dit opnemen in `connect.params.auth.token`, zelfs over de tunnel.

## Meerdere gateways (zelfde host)

Meestal onnodig: één Gateway kan meerdere messagingkanalen en agents bedienen. Gebruik meerdere Gateways alleen voor redundantie of strikte isolatie (bijv. rescue bot).

Ondersteund als je state + config isoleert en unieke poorten gebruikt. Volledige gids: [Multiple gateways](/gateway/multiple-gateways).

Servicenamen zijn profielbewust:

- macOS: `bot.molt.<profile>` (legacy `com.openclaw.*` kan nog bestaan)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Installatiemetadata is ingebed in de serviceconfig:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot-patroon: houd een tweede Gateway geïsoleerd met een eigen profiel, state-dir, werkruimte en basispoort-opschaling. Volledige gids: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Dev-profiel (`--dev`)

Snelle route: draai een volledig geïsoleerde dev-instantie (config/state/werkruimte) zonder je primaire setup aan te raken.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Standaarden (kunnen worden overschreven via env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- browser control service-poort = `19003` (afgeleid: `gateway.port+2`, alleen loopback)
- `canvasHost.port=19005` (afgeleid: `gateway.port+4`)
- `agents.defaults.workspace` wordt standaard `~/.openclaw/workspace-dev` wanneer je `setup`/`onboard` draait onder `--dev`.

Afgeleide poorten (vuistregels):

- Basispoort = `gateway.port` (of `OPENCLAW_GATEWAY_PORT` / `--port`)
- browser control service-poort = basis + 2 (alleen loopback)
- `canvasHost.port = base + 4` (of `OPENCLAW_CANVAS_HOST_PORT` / config-override)
- Browserprofiel CDP-poorten worden automatisch toegewezen vanaf `browser.controlPort + 9 .. + 108` (per profiel opgeslagen).

Checklist per instantie:

- unieke `gateway.port`
- unieke `OPENCLAW_CONFIG_PATH`
- unieke `OPENCLAW_STATE_DIR`
- unieke `agents.defaults.workspace`
- aparte WhatsApp-nummers (als je WA gebruikt)

Service-installatie per profiel:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Voorbeeld:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocol (operatorperspectief)

- Volledige documentatie: [Gateway protocol](/gateway/protocol) en [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Verplicht eerste frame van client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway antwoordt met `res {type:"res", id, ok:true, payload:hello-ok }` (of `ok:false` met een fout, en sluit daarna).
- Na handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Gestructureerde presence-entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (voor WS-clients komt `instanceId` van `connect.client.instanceId`).
- `agent`-responses zijn tweefasig: eerst `res` ack `{runId,status:"accepted"}`, daarna een finale `res` `{runId,status:"ok"|"error",summary}` nadat de run is voltooid; gestreamde uitvoer arriveert als `event:"agent"`.

## Methoden (initiële set)

- `health` — volledige health-snapshot (zelfde vorm als `openclaw health --json`).
- `status` — korte samenvatting.
- `system-presence` — huidige presence-lijst.
- `system-event` — plaats een presence-/systeemnotitie (gestructureerd).
- `send` — verstuur een bericht via de actieve kanaal(en).
- `agent` — voer een agent-turn uit (streamt events terug over dezelfde verbinding).
- `node.list` — lijst gekoppelde + momenteel verbonden nodes (inclusief `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` en geadverteerde `commands`).
- `node.describe` — beschrijf een node (capaciteiten + ondersteunde `node.invoke`-opdrachten; werkt voor gekoppelde nodes en voor momenteel verbonden niet-gekoppelde nodes).
- `node.invoke` — roep een opdracht aan op een node (bijv. `canvas.*`, `camera.*`).
- `node.pair.*` — koppelingslevenscyclus (`request`, `list`, `approve`, `reject`, `verify`).

Zie ook: [Presence](/concepts/presence) voor hoe presence wordt geproduceerd/gededupliceerd en waarom een stabiele `client.instanceId` belangrijk is.

## Events

- `agent` — gestreamde tool-/output-events van de agent-run (seq-getagd).
- `presence` — presence-updates (delta’s met stateVersion) die naar alle verbonden clients worden gepusht.
- `tick` — periodieke keepalive/no-op om liveness te bevestigen.
- `shutdown` — Gateway sluit af; payload bevat `reason` en optioneel `restartExpectedMs`. Clients moeten opnieuw verbinden.

## WebChat-integratie

- WebChat is een native SwiftUI-UI die rechtstreeks met de Gateway WebSocket praat voor geschiedenis, verzenden, afbreken en events.
- Extern gebruik gaat via dezelfde SSH/Tailscale-tunnel; als een gateway-token is geconfigureerd, neemt de client dit mee tijdens `connect`.
- De macOS-app verbindt via één enkele WS (gedeelde verbinding); hydrateert presence vanuit de initiële snapshot en luistert naar `presence`-events om de UI bij te werken.

## Typing en validatie

- De server valideert elk inkomend frame met AJV tegen JSON Schema die uit de protocoldefinities wordt gegenereerd.
- Clients (TS/Swift) gebruiken gegenereerde types (TS direct; Swift via de generator van de repo).
- Protocoldefinities zijn de bron van waarheid; genereer schema/models opnieuw met:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Verbindingssnapshot

- `hello-ok` bevat een `snapshot` met `presence`, `health`, `stateVersion` en `uptimeMs` plus `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`, zodat clients direct kunnen renderen zonder extra requests.
- `health`/`system-presence` blijven beschikbaar voor handmatige refresh, maar zijn niet vereist bij het verbinden.

## Foutcodes (res.error-vorm)

- Fouten gebruiken `{ code, message, details?, retryable?, retryAfterMs? }`.
- Standaardcodes:
  - `NOT_LINKED` — WhatsApp niet geauthenticeerd.
  - `AGENT_TIMEOUT` — agent reageerde niet binnen de geconfigureerde deadline.
  - `INVALID_REQUEST` — schema-/parametervalidatie mislukt.
  - `UNAVAILABLE` — Gateway wordt afgesloten of een afhankelijkheid is niet beschikbaar.

## Keepalive-gedrag

- `tick`-events (of WS ping/pong) worden periodiek uitgezonden zodat clients weten dat de Gateway leeft, zelfs wanneer er geen verkeer is.
- Send-/agent-acknowledgements blijven aparte responses; overlaad ticks niet voor sends.

## Replay / hiaten

- Events worden niet herhaald. Clients detecteren seq-hiaten en moeten verversen (`health` + `system-presence`) voordat ze doorgaan. WebChat- en macOS-clients verversen nu automatisch bij een hiaat.

## Supervisie (macOS-voorbeeld)

- Gebruik launchd om de service draaiende te houden:
  - Program: pad naar `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: bestandspaden of `syslog`
- Bij falen herstart launchd; fatale misconfiguratie moet blijven afsluiten zodat de operator het merkt.
- LaunchAgents zijn per gebruiker en vereisen een ingelogde sessie; gebruik voor headless setups een aangepaste LaunchDaemon (niet meegeleverd).
  - `openclaw gateway install` schrijft `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (of `bot.molt.<profile>.plist`; legacy `com.openclaw.*` wordt opgeruimd).
  - `openclaw doctor` controleert de LaunchAgent-config en kan deze bijwerken naar de huidige standaardinstellingen.

## Gateway servicebeheer (CLI)

Gebruik de Gateway CLI voor install/start/stop/restart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Notities:

- `gateway status` test standaard de Gateway RPC met de door de service opgeloste poort/config (overschrijven met `--url`).
- `gateway status --deep` voegt systeemniveau-scans toe (LaunchDaemons/system units).
- `gateway status --no-probe` slaat de RPC-probe over (handig wanneer networking down is).
- `gateway status --json` is stabiel voor scripts.
- `gateway status` rapporteert **supervisor runtime** (launchd/systemd draait) apart van **RPC-bereikbaarheid** (WS-verbinding + status RPC).
- `gateway status` print het configpad + probe-doel om verwarring over “localhost vs LAN bind” en profielmismatches te voorkomen.
- `gateway status` bevat de laatste gateway-foutregel wanneer de service lijkt te draaien maar de poort gesloten is.
- `logs` volgt het Gateway-bestandslog via RPC (geen handmatige `tail`/`grep` nodig).
- Als andere gateway-achtige services worden gedetecteerd, waarschuwt de CLI tenzij het OpenClaw-profielservices zijn.
  We raden nog steeds **één gateway per machine** aan voor de meeste setups; gebruik geïsoleerde profielen/poorten voor redundantie of een rescue bot. Zie [Multiple gateways](/gateway/multiple-gateways).
  - Opruimen: `openclaw gateway uninstall` (huidige service) en `openclaw doctor` (legacy migraties).
- `gateway install` is een no-op wanneer al geïnstalleerd; gebruik `openclaw gateway install --force` om opnieuw te installeren (profiel/env/pad-wijzigingen).

Gebundelde mac-app:

- OpenClaw.app kan een Node-gebaseerde gateway-relay bundelen en een per-gebruiker LaunchAgent installeren met label
  `bot.molt.gateway` (of `bot.molt.<profile>`; legacy `com.openclaw.*`-labels worden nog netjes unloaded).
- Om deze netjes te stoppen, gebruik `openclaw gateway stop` (of `launchctl bootout gui/$UID/bot.molt.gateway`).
- Om te herstarten, gebruik `openclaw gateway restart` (of `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` werkt alleen als de LaunchAgent is geïnstalleerd; gebruik anders eerst `openclaw gateway install`.
  - Vervang het label door `bot.molt.<profile>` wanneer je een benoemd profiel draait.

## Supervisie (systemd user unit)

OpenClaw installeert standaard een **systemd user service** op Linux/WSL2. We
raden user services aan voor single-user machines (eenvoudigere env, per-gebruiker config).
Gebruik een **system service** voor multi-user of always-on servers (geen lingering
vereist, gedeelde supervisie).

`openclaw gateway install` schrijft de user unit. `openclaw doctor` controleert de
unit en kan deze bijwerken om overeen te komen met de huidige aanbevolen standaardinstellingen.

Maak `~/.config/systemd/user/openclaw-gateway[-<profile>].service` aan:

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

Schakel lingering in (vereist zodat de user service logout/idle overleeft):

```
sudo loginctl enable-linger youruser
```

Onboarding voert dit uit op Linux/WSL2 (kan om sudo vragen; schrijft `/var/lib/systemd/linger`).
Schakel daarna de service in:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternatief (system service)** – voor always-on of multi-user servers kun je
in plaats van een user unit een systemd **system** unit installeren (geen lingering nodig).
Maak `/etc/systemd/system/openclaw-gateway[-<profile>].service` aan (kopieer de unit hierboven,
wissel `WantedBy=multi-user.target`, stel `User=` + `WorkingDirectory=` in), en voer daarna uit:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows-installaties moeten **WSL2** gebruiken en de Linux systemd-sectie hierboven volgen.

## Operationele controles

- Liveness: open WS en stuur `req:connect` → verwacht `res` met `payload.type="hello-ok"` (met snapshot).
- Readiness: roep `health` aan → verwacht `ok: true` en een gekoppeld kanaal in `linkChannel` (indien van toepassing).
- Debug: abonneer op `tick`- en `presence`-events; zorg dat `status` gekoppelde/auth-leeftijd toont; presence-entries tonen Gateway-host en verbonden clients.

## Veiligheidsgaranties

- Ga standaard uit van één Gateway per host; als je meerdere profielen draait, isoleer poorten/state en target de juiste instantie.
- Geen fallback naar directe Baileys-verbindingen; als de Gateway down is, falen sends snel.
- Niet-connect first frames of malformed JSON worden geweigerd en de socket wordt gesloten.
- Graceful shutdown: zend `shutdown`-event vóór sluiten; clients moeten sluiten + opnieuw verbinden afhandelen.

## CLI-hulpmiddelen

- `openclaw gateway health|status` — vraag health/status op via de Gateway WS.
- `openclaw message send --target <num> --message "hi" [--media ...]` — verstuur via Gateway (idempotent voor WhatsApp).
- `openclaw agent --message "hi" --to <num>` — voer een agent-turn uit (wacht standaard op de finale).
- `openclaw gateway call <method> --params '{"k":"v"}'` — ruwe method-invoker voor debugging.
- `openclaw gateway stop|restart` — stop/herstart de gesuperviseerde gateway-service (launchd/systemd).
- Gateway helper-subcommando’s gaan uit van een draaiende gateway op `--url`; ze starten er niet langer automatisch één.

## Migratierichtlijnen

- Beëindig gebruik van `openclaw gateway` en de legacy TCP control-poort.
- Werk clients bij om het WS-protocol te spreken met verplichte connect en gestructureerde presence.
