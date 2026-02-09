---
summary: "Runbook for Gateway-tjenesten, livscyklus og drift"
read_when:
  - Når du kører eller fejlsøger gateway-processen
title: "Gateway Runbook"
---

# Gateway service runbook

Sidst opdateret: 2025-12-09

## Hvad det er

- Den altid-kørende proces, der ejer den enkelte Baileys/Telegram-forbindelse samt kontrol-/event-planen.
- Erstatter arven `gateway` kommando. CLI indgangspunkt: »openclaw gateway«.
- Kører indtil den stoppes; afslutter med ikke-nul ved fatale fejl, så supervisoren genstarter den.

## Sådan køres den (lokalt)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Hot reload af konfiguration overvåger `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`).
  - Standardtilstand: `gateway.reload.mode="hybrid"` (hot-anvend sikre ændringer, genstart ved kritiske).
  - Hot reload bruger in-process genstart via **SIGUSR1** når nødvendigt.
  - Deaktiver med `gateway.reload.mode="off"`.
- Binder WebSocket-kontrolplanet til `127.0.0.1:<port>` (standard 18789).
- Den samme port serverer også HTTP (kontrol UI, hooks, A2UI). Enkeltport multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Starter en lærred filserver som standard på `canvasHost.port` (standard `18793`), betjener `http://<gateway-host>:18793/__openclaw__/canvas/` fra `~/.openclaw/workspace/canvas`. Deaktivér med `canvasHost.enabled=false` eller `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Logger til stdout; brug launchd/systemd til at holde den kørende og rotere logs.
- Giv `--verbose` for at spejle debug-logging (handshakes, req/res, events) fra logfilen til stdio ved fejlsøgning.
- `--force` bruger `lsof` til at finde lyttere på den valgte port, sender SIGTERM, logger hvad der blev dræbt, og starter derefter gatewayen (fejler hurtigt hvis `lsof` mangler).
- Hvis du kører under en supervisor (launchd/systemd/mac app child-process-tilstand), sender et stop/genstart typisk **SIGTERM**; ældre builds kan vise dette som `pnpm` `ELIFECYCLE` exitkode **143** (SIGTERM), hvilket er en normal nedlukning, ikke et crash.
- **SIGUSR1** udløser en in-process genstart, når autoriseret (gateway-værktøj/konfig anvend/opdater, eller aktiver `commands.restart` for manuelle genstarter).
- Gateway auth kræves som standard: sæt `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) eller `gateway.auth.password`. Kunderne skal sende `connect.params.auth.token/password` medmindre du bruger Tailscale Serve identitet.
- Opsætningsguiden genererer nu som standard et token, selv på loopback.
- Port-prioritet: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > standard `18789`.

## Fjernadgang

- Tailscale/VPN foretrækkes; ellers SSH-tunnel:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Klienter forbinder derefter til `ws://127.0.0.1:18789` gennem tunnelen.

- Hvis et token er konfigureret, skal klienter inkludere det i `connect.params.auth.token`, selv over tunnelen.

## Flere gateways (samme vært)

Normalt unødvendigt: en Gateway kan tjene flere messaging kanaler og agenter. Brug flere Gateways kun for redundans eller streng isolation (ex: rescue bot).

Understøttet hvis du isolere stat + config og bruge unikke porte. Fuld guide: [Flere gateways](/gateway/multiple-gateways).

Tjenestenavne er profilbevidste:

- macOS: `bot.molt.<profile>` (arv `com.openclaw.*` kan stadig eksistere)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Installationsmetadata er indlejret i servicekonfigurationen:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Mønster: holde en anden Gateway isoleret med sin egen profil, state dir, arbejdsområde og base port afstand. Fuld guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Dev-profil (`--dev`)

Hurtig vej: kør en fuldt isoleret dev-instans (konfig/state/workspace) uden at røre din primære opsætning.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Standarder (kan tilsidesættes via env/flags/konfig):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- browser control service port = `19003` (afledt: `gateway.port+2`, kun loopback)
- `canvasHost.port=19005` (afledt: `gateway.port+4`)
- `agents.defaults.workspace` bliver som standard `~/.openclaw/workspace-dev`, når du kører `setup`/`onboard` under `--dev`.

Afledte porte (tommelfingerregler):

- Base-port = `gateway.port` (eller `OPENCLAW_GATEWAY_PORT` / `--port`)
- browser control service port = base + 2 (kun loopback)
- `canvasHost.port = base + 4` (eller `OPENCLAW_CANVAS_HOST_PORT` / konfig-override)
- Browser profil CDP porte auto-allokere fra `browser.controlPort + 9 .. + 108` (persisted per profil).

Tjekliste pr. instans:

- unik `gateway.port`
- unik `OPENCLAW_CONFIG_PATH`
- unik `OPENCLAW_STATE_DIR`
- unik `agents.defaults.workspace`
- separate WhatsApp-numre (hvis WA bruges)

Serviceinstallation pr. profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Eksempel:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protokol (operatørvisning)

- Fuld dokumentation: [Gateway protocol](/gateway/protocol) og [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Obligatorisk første ramme fra klient: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway svarer med `res {type:"res", id, ok:true, payload:hello-ok }` (eller `ok:false` med en fejl, hvorefter den lukker).
- Efter handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Strukturerede tilstedeværelse indgange: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, årsag?, tags?[], instanceId? }` (for WS klienter, `instanceId` kommer fra `connect.client.instanceId`).
- `agent`-svar er to-trins: først `res` ack `{runId,status:"accepted"}`, derefter et endeligt `res` `{runId,status:"ok"|"error",summary}`, når kørslen er færdig; streamet output ankommer som `event:"agent"`.

## Metoder (initialt sæt)

- `health` — fuldt health-snapshot (samme form som `openclaw health --json`).
- `status` — kort oversigt.
- `system-presence` — aktuel presence-liste.
- `system-event` — post en presence-/systemnote (struktureret).
- `send` — send en besked via de aktive kanal(er).
- `agent` — kør en agent-turn (streamer events tilbage på samme forbindelse).
- `node.list` — list parrede + aktuelt forbundne noder (inkluderer `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` og annoncerede `commands`).
- `node.describe` — beskriv en node (kapabiliteter + understøttede `node.invoke`-kommandoer; virker for parrede noder og for aktuelt forbundne uparrede noder).
- `node.invoke` — kald en kommando på en node (fx `canvas.*`, `camera.*`).
- `node.pair.*` — paringslivscyklus (`request`, `list`, `approve`, `reject`, `verify`).

Se også: [Presence](/concepts/presence) for hvordan presence produceres/af-dubleres, og hvorfor en stabil `client.instanceId` er vigtig.

## Events

- `agent` — streamede tool-/output-events fra agentkørslen (sekvens-tagget).
- `presence` — presence-opdateringer (deltaer med stateVersion) skubbet til alle forbundne klienter.
- `tick` — periodisk keepalive/no-op for at bekræfte livstegn.
- `nedlukning` — Gateway afslutter; nyttelasten omfatter `årsag` og valgfri `restartExpectedMs`. Klienter skal oprette forbindelse igen.

## WebChat-integration

- WebChat er en indbygget SwiftUI-UI, der taler direkte med Gateway WebSocket for historik, sending, abort og events.
- Fjernbrug går gennem samme SSH/Tailscale-tunnel; hvis et gateway-token er konfigureret, inkluderer klienten det under `connect`.
- macOS-appen forbinder via én enkelt WS (delt forbindelse); den hydrerer presence fra det indledende snapshot og lytter efter `presence`-events for at opdatere UI’et.

## Typning og validering

- Serveren validerer hver indgående frame med AJV mod JSON Schema, der genereres fra protokoldefinitionerne.
- Klienter (TS/Swift) bruger genererede typer (TS direkte; Swift via repoets generator).
- Protokoldefinitioner er sandhedskilden; regenerér schema/modeller med:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Forbindelses-snapshot

- `hello-ok` inkluderer et `snapshot` med `presence`, `health`, `stateVersion` og `uptimeMs` samt `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`, så klienter kan rendere med det samme uden ekstra forespørgsler.
- `health`/`system-presence` er fortsat tilgængelige til manuel opdatering, men er ikke påkrævet ved forbindelsestidspunktet.

## Fejlkoder (res.error-form)

- Fejl bruger `{ kode, besked, detaljer?, prøver igen?, gentryAfterMs? }`.
- Standardkoder:
  - `NOT_LINKED` — WhatsApp er ikke autentificeret.
  - `AGENT_TIMEOUT` — agenten svarede ikke inden for den konfigurerede deadline.
  - `INVALID_REQUEST` — schema-/parametervalidering fejlede.
  - `UNAVAILABLE` — Gateway lukker ned, eller en afhængighed er utilgængelig.

## Keepalive-adfærd

- `tick`-events (eller WS ping/pong) udsendes periodisk, så klienter ved, at Gateway er i live, selv når der ikke er trafik.
- Send-/agent-acknowledgements forbliver separate svar; overbelast ikke ticks til sendinger.

## Replay / huller

- Begivenheder afspilles ikke igen. Kunderne opdager seq huller og bør opdatere (`sundhed` + `system-tilstedeværelse`), før du fortsætter. WebChat og macOS klienter opdaterer nu automatisk på mellemrum.

## Supervision (macOS-eksempel)

- Brug launchd til at holde tjenesten i live:
  - Program: sti til `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: filstier eller `syslog`
- Ved fejl genstarter launchd; fatal fejlkonfiguration bør fortsætte med at afslutte, så operatøren opdager det.
- LaunchAgents er pr. bruger og kræver en logget-ind session; for headless-opsætninger brug en brugerdefineret LaunchDaemon (medfølger ikke).
  - `openclaw gateway install` skriver `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (eller `bot.molt.<profile>.plist`; arven `com.openclaw.*` bliver renset).
  - `openclaw doctor` auditerer LaunchAgent-konfigurationen og kan opdatere den til de aktuelle standarder.

## Gateway service management (CLI)

Brug Gateway CLI til install/start/stop/genstart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Noter:

- `gateway status` sonderer Gateway RPC som standard ved brug af tjenestens opløste port/konfiguration (kan tilsidesættes med `--url`).
- `gateway status --deep` tilføjer systemniveau-scanninger (LaunchDaemons/system-enheder).
- `gateway status --no-probe` springer RPC-sonden over (nyttigt når netværk er nede).
- `gateway status --json` er stabil til scripts.
- `gateway status` rapporterer **supervisor runtime** (launchd/systemd kører) separat fra **RPC-tilgængelighed** (WS-forbindelse + status RPC).
- `gateway status` udskriver konfigsti + sondemål for at undgå “localhost vs LAN bind”-forvirring og profil-mismatch.
- `gateway status` inkluderer den sidste gateway-fejllinje, når tjenesten ser kørende ud, men porten er lukket.
- `logs` tailer Gateway-fil-loggen via RPC (ingen manuel `tail`/`grep` nødvendig).
- Hvis andre gateway-lignende tjenester er opdaget, CLI advarer medmindre de er OpenClaw profil tjenester.
  Vi anbefaler stadig **one gateway per machine** for de fleste opsætninger; bruge isolerede profiler/porte til redundans eller en redningsbåd. Se [Flere gateways](/gateway/multiple-gateways).
  - Oprydning: `openclaw gateway uninstall` (aktuel tjeneste) og `openclaw doctor` (legacy-migreringer).
- `gateway install` er en no-op, når den allerede er installeret; brug `openclaw gateway install --force` til at geninstallere (profil/env/sti-ændringer).

Bundlet mac-app:

- OpenClaw.app kan samle et node-baseret gateway relæ og installere en per-bruger LaunchAgent mærket
  `bot.molt.gateway` (eller `bot.molt. molt.<profile>`; arv `com.openclaw.*` etiketter stadig losses ren).
- For at stoppe den rent, brug `openclaw gateway stop` (eller `launchctl bootout gui/$UID/bot.molt.gateway`).
- For at genstarte, brug `openclaw gateway restart` (eller `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` virker kun, hvis LaunchAgent er installeret; ellers brug `openclaw gateway install` først.
  - Erstat etiketten med bot.molt.<profile>\` når du kører en navngiven profil.

## Supervision (systemd bruger-enhed)

OpenClaw installerer som standard en **systemd brugerservice** på Linux/WSL2. Vi
anbefaler brugertjenester til enkeltbrugermaskiner (enklere env, per-user config).
Brug en **systemservice** til flerbruger- eller altid-on-servere (ingen dingende
kræves, delt overvågning).

`openclaw gateway install` skriver brugerenheden. `openclaw doctor` reviderer
enheden og kan opdatere den til at matche de aktuelle anbefalede standardværdier.

Opret `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

Aktivér lingering (påkrævet, så brugertjenesten overlever logout/idle):

```
sudo loginctl enable-linger youruser
```

Onboarding kører dette på Linux/WSL2 (kan bede om sudo; skriver `/var/lib/systemd/linger`).
Aktiver derefter tjenesten:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternativ (systemservice)** - for altid-on eller multi-user servere, kan du
installere en systemd **system** enhed i stedet for en brugerenhed (ingen dvale behov).
Opret `/etc/systemd/system/openclaw-gateway[-<profile>].service` (kopier enheden ovenfor,
skift `WantedBy=multi-user.target`, sæt `User=` + `WorkingDirectory=`), så:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows-installationer bør bruge **WSL2** og følge Linux systemd-afsnittet ovenfor.

## Driftskontroller

- Liveness: åbn WS og send `req:connect` → forvent `res` med `payload.type="hello-ok"` (med snapshot).
- Readiness: kald `health` → forvent `ok: true` og en linket kanal i `linkChannel` (når relevant).
- Debug: abonnér på `tick`- og `presence`-events; sørg for, at `status` viser linket/autentificeringsalder; presence-poster viser gateway-vært og forbundne klienter.

## Sikkerhedsgarantier

- Antag én Gateway pr. vært som standard; hvis du kører flere profiler, isolér porte/state og målret den rigtige instans.
- Ingen fallback til direkte Baileys-forbindelser; hvis Gateway er nede, fejler sendinger hurtigt.
- Ikke-connect første frames eller forkert JSON afvises, og socketten lukkes.
- Graciøs nedlukning: udsend `shutdown`-event før lukning; klienter skal håndtere lukning + genforbindelse.

## CLI-hjælpere

- `openclaw gateway health|status` — forespørg health/status over Gateway WS.
- `openclaw message send --target <num> --message "hi" [--media ...]` — send via Gateway (idempotent for WhatsApp).
- `openclaw agent --message "hi" --to <num>` — kør en agent-turn (venter på endeligt svar som standard).
- `openclaw gateway call <method> --params '{"k":"v"}'` — rå metode-invoker til fejlsøgning.
- `openclaw gateway stop|restart` — stop/genstart den superviserede gateway-tjeneste (launchd/systemd).
- Gateway-hjælperunderkommandoer antager en kørende gateway på `--url`; de auto-starter ikke længere en.

## Migreringsvejledning

- Udfas brug af `openclaw gateway` og den gamle TCP-kontrolport.
- Opdatér klienter til at tale WS-protokollen med obligatorisk connect og struktureret presence.
