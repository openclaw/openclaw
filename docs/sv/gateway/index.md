---
summary: "Drifthandbok för Gateway-tjänsten, livscykel och drift"
read_when:
  - När du kör eller felsöker gateway-processen
title: "Gateway-drifthandbok"
---

# Drifthandbok för Gateway-tjänsten

Senast uppdaterad: 2025-12-09

## Vad det är

- Den alltid aktiva processen som äger den enda Baileys/Telegram-anslutningen samt kontroll-/händelseplanet.
- Ersätter äldre `gateway`-kommandot. CLI ingångspunkt: `openclaw gateway`.
- Kör tills den stoppas; avslutas med icke-noll vid fatala fel så att övervakaren startar om den.

## Hur man kör (lokalt)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Konfigurations-hot reload bevakar `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`).
  - Standardläge: `gateway.reload.mode="hybrid"` (tillämpa säkra ändringar direkt, starta om vid kritiska).
  - Hot reload använder omstart i processen via **SIGUSR1** vid behov.
  - Inaktivera med `gateway.reload.mode="off"`.
- Binder WebSocket-kontrollplanet till `127.0.0.1:<port>` (standard 18789).
- Samma port tjänar också HTTP (control UI, hooks, A2UI). Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Startar en Canvas-fil server som standard på `canvasHost.port` (standard `18793`), betjänar `http://<gateway-host>:18793/__openclaw__/canvas/` från `~/.openclaw/workspace/canvas`. Inaktivera med `canvasHost.enabled=false` eller `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Loggar till stdout; använd launchd/systemd för att hålla den igång och rotera loggar.
- Skicka `--verbose` för att spegla debug-loggning (handshakes, req/res, händelser) från loggfilen till stdio vid felsökning.
- `--force` använder `lsof` för att hitta lyssnare på vald port, skickar SIGTERM, loggar vad som dödades och startar sedan gatewayn (avslutas snabbt om `lsof` saknas).
- Om du kör under en övervakare (launchd/systemd/mac-appens barnprocessläge) skickar ett stopp/omstart vanligtvis **SIGTERM**; äldre byggen kan visa detta som `pnpm` `ELIFECYCLE` med exitkod **143** (SIGTERM), vilket är en normal avstängning, inte en krasch.
- **SIGUSR1** triggar en omstart i processen när den är auktoriserad (gateway-verktyg/konfig tillämpa/uppdatera, eller aktivera `commands.restart` för manuella omstarter).
- Gateway auth krävs som standard: sätt `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) eller `gateway.auth.password`. Klienter måste skicka `connect.params.auth.token/password` om du inte använder Tailscale Serve identitet.
- Guiden genererar nu som standard en token, även på loopback.
- Portprioritet: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > standard `18789`.

## Fjärråtkomst

- Tailscale/VPN föredras; annars SSH-tunnel:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Klienter ansluter sedan till `ws://127.0.0.1:18789` genom tunneln.

- Om en token är konfigurerad måste klienter inkludera den i `connect.params.auth.token` även över tunneln.

## Flera gateways (samma värd)

Vanligtvis onödigt: en Gateway kan tjäna flera meddelandekanaler och agenter. Använd flera Gateways endast för redundans eller strikt isolering (ex: räddningsbot).

Stöds om du isolerar status + konfiguration och använder unika portar. Fullständig guide: [Flera gateways](/gateway/multiple-gateways).

Tjänstnamn är profilanpassade:

- macOS: `bot.molt.<profile>` (äldre `com.openclaw.*` kan fortfarande finnas)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Installationsmetadata är inbäddade i tjänstekonfigen:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: hålla en andra Gateway isolerad med sin egen profil, state dir, arbetsyta och bas portavstånd. Fullständig guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Dev-profil (`--dev`)

Snabbaste vägen: kör en helt isolerad dev-instans (konfig/tillstånd/arbetsyta) utan att röra din primära setup.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Standardvärden (kan åsidosättas via env/flaggor/konfig):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- webbläsarens kontrolltjänstport = `19003` (härledd: `gateway.port+2`, endast loopback)
- `canvasHost.port=19005` (härledd: `gateway.port+4`)
- `agents.defaults.workspace` blir som standard `~/.openclaw/workspace-dev` när du kör `setup`/`onboard` under `--dev`.

Härledda portar (tumregler):

- Basport = `gateway.port` (eller `OPENCLAW_GATEWAY_PORT` / `--port`)
- webbläsarens kontrolltjänstport = bas + 2 (endast loopback)
- `canvasHost.port = base + 4` (eller `OPENCLAW_CANVAS_HOST_PORT` / konfig-åsidosättning)
- Webbläsarprofil CDP-portar automatiskt allokera från `browser.controlPort + 9 .. + 108` (persisted per profil).

Checklista per instans:

- unik `gateway.port`
- unik `OPENCLAW_CONFIG_PATH`
- unik `OPENCLAW_STATE_DIR`
- unik `agents.defaults.workspace`
- separata WhatsApp-nummer (om WA används)

Tjänstinstallation per profil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Exempel:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protokoll (operatörsvy)

- Fullständig dokumentation: [Gateway-protokoll](/gateway/protocol) och [Bridge-protokoll (legacy)](/gateway/bridge-protocol).
- Obligatorisk första ram från klienten: `req {type:"req", id, metod:"connect", parametrar:{minProtocol,maxProtocol,client:{id,displayName?,version,plattform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway svarar med `res {type:"res", id, ok:true, payload:hello-ok }` (eller `ok:false` med ett fel, och stänger sedan).
- Efter handskakning:
  - Förfrågningar: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Händelser: `{type:"event", event, payload, seq?, stateVersion?}`
- Strukturerade närvaroposter: `{hostst, ip, version, plattform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, anledning?, taggar?[], instanceId? }` (för WS-klienter, `instanceId` kommer från `connect.client.instanceId`).
- `agent`-svar är tvåstegs: först `res`-ack `{runId,status:"accepted"}`, därefter ett slutligt `res` `{runId,status:"ok"|"error",summary}` efter att körningen avslutats; strömmad utdata anländer som `event:"agent"`.

## Metoder (initial uppsättning)

- `health` — fullständig hälsobild (samma form som `openclaw health --json`).
- `status` — kort sammanfattning.
- `system-presence` — aktuell närvarolista.
- `system-event` — posta en närvaro-/systemnotis (strukturerad).
- `send` — skicka ett meddelande via den/de aktiva kanalen/kanalerna.
- `agent` — kör en agenttur (strömmar händelser tillbaka på samma anslutning).
- `node.list` — lista parade + för närvarande anslutna noder (inkluderar `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` och annonserade `commands`).
- `node.describe` — beskriv en nod (funktioner + stödda `node.invoke`-kommandon; fungerar för parade noder och för för närvarande anslutna oparade noder).
- `node.invoke` — anropa ett kommando på en nod (t.ex. `canvas.*`, `camera.*`).
- `node.pair.*` — parningslivscykel (`request`, `list`, `approve`, `reject`, `verify`).

Se även: [Närvaro](/concepts/presence) för hur närvaro produceras/dedupliceras och varför ett stabilt `client.instanceId` är viktigt.

## Händelser

- `agent` — strömmade verktygs-/utdatahändelser från agentkörningen (sekvens-taggade).
- `presence` — närvarouppdateringar (deltor med stateVersion) pushas till alla anslutna klienter.
- `tick` — periodisk keepalive/no-op för att bekräfta liv.
- `shutdown` - Gateway avslutas; payload innehåller `reason` och valfri `restartExpectedMs`. Klienter bör återansluta.

## WebChat-integration

- WebChat är ett inbyggt SwiftUI-UI som pratar direkt med Gateway-WebSocket för historik, sändningar, avbrott och händelser.
- Fjärranvändning går via samma SSH/Tailscale-tunnel; om en gateway-token är konfigurerad inkluderar klienten den under `connect`.
- macOS-appen ansluter via en enda WS (delad anslutning); den hydratiserar närvaro från den initiala ögonblicksbilden och lyssnar på `presence`-händelser för att uppdatera UI:t.

## Typning och validering

- Servern validerar varje inkommande frame med AJV mot JSON Schema som emitteras från protokolldefinitionerna.
- Klienter (TS/Swift) konsumerar genererade typer (TS direkt; Swift via repots generator).
- Protokolldefinitionerna är sanningskällan; regenerera schema/modeller med:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Anslutningsögonblicksbild

- `hello-ok` inkluderar en `snapshot` med `presence`, `health`, `stateVersion` och `uptimeMs` samt `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` så att klienter kan rendera direkt utan extra förfrågningar.
- `health`/`system-presence` finns kvar för manuell uppdatering, men krävs inte vid anslutning.

## Felkoder (res.error-form)

- Fel använder `{ kod, meddelande, detaljer?, återförsökbar?, retryAfterMs? }`.
- Standardkoder:
  - `NOT_LINKED` — WhatsApp inte autentiserat.
  - `AGENT_TIMEOUT` — agenten svarade inte inom den konfigurerade tidsgränsen.
  - `INVALID_REQUEST` — schema-/parametervalidering misslyckades.
  - `UNAVAILABLE` — Gateway håller på att stängas av eller ett beroende är otillgängligt.

## Keepalive-beteende

- `tick`-händelser (eller WS ping/pong) emitteras periodiskt så att klienter vet att Gateway är vid liv även när ingen trafik sker.
- Sänd-/agent-acknowledgements är separata svar; överbelasta inte tickar för sändningar.

## Replay / glapp

- Händelser spelas inte om. Klienter känner av kryphål och bör uppdatera (`health` + `system-presence`) innan de fortsätter. WebChat och macOS klienter uppdateras nu automatiskt vid lucka.

## Övervakning (macOS-exempel)

- Använd launchd för att hålla tjänsten vid liv:
  - Program: sökväg till `openclaw`
  - Argument: `gateway`
  - KeepAlive: true
  - StandardOut/Err: filsökvägar eller `syslog`
- Vid fel startar launchd om; fatal felkonfiguration bör fortsätta avsluta så att operatören märker det.
- LaunchAgents är per användare och kräver en inloggad session; för headless-uppsättningar använd en anpassad LaunchDaemon (levereras inte).
  - `openclaw gateway install` skriver `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (eller `bot.molt.<profile>.plist`; äldre `com.openclaw.*` rensas upp).
  - `openclaw doctor` granskar LaunchAgent-konfigen och kan uppdatera den till aktuella standarder.

## Hantering av Gateway-tjänsten (CLI)

Använd Gateway-CLI för install/start/stop/restart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Noteringar:

- `gateway status` sonderar Gateway-RPC som standard med tjänstens lösta port/konfig (åsidosätt med `--url`).
- `gateway status --deep` lägger till systemomfattande skanningar (LaunchDaemons/systemenheter).
- `gateway status --no-probe` hoppar över RPC-sonderingen (användbart när nätverk är nere).
- `gateway status --json` är stabilt för skript.
- `gateway status` rapporterar **övervakarens körtid** (launchd/systemd kör) separat från **RPC-nåbarhet** (WS-anslutning + status-RPC).
- `gateway status` skriver ut konfigsökväg + sondmål för att undvika förvirring kring ”localhost vs LAN-bindning” och profilmissmatchningar.
- `gateway status` inkluderar den senaste gateway-felraden när tjänsten ser ut att köra men porten är stängd.
- `logs` tailar Gateway-fil-loggen via RPC (inga manuella `tail`/`grep` behövs).
- Om andra gateway-liknande tjänster upptäcks, varnar CLI om de inte är OpenClaw profiltjänster.
  Vi rekommenderar fortfarande **en gateway per maskin** för de flesta inställningar; använd isolerade profiler/portar för redundans eller en räddningsbot. Se [Flera gateways](/gateway/multiple-gateways).
  - Städning: `openclaw gateway uninstall` (aktuell tjänst) och `openclaw doctor` (äldre migreringar).
- `gateway install` är en no-op när den redan är installerad; använd `openclaw gateway install --force` för att installera om (profil-/env-/sökvägsändringar).

Paketerad mac-app:

- OpenClaw.app kan bunta ihop ett nodbaserat gateway-relä och installera en LaunchAgent som är märkt
  `bot.molt.gateway` (eller `bot.molt.<profile>`; äldre `com.openclaw.*` etiketter lastar fortfarande ren).
- För att stoppa den på ett rent sätt, använd `openclaw gateway stop` (eller `launchctl bootout gui/$UID/bot.molt.gateway`).
- För att starta om, använd `openclaw gateway restart` (eller `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` fungerar endast om LaunchAgent är installerad; annars använd `openclaw gateway install` först.
  - Ersätt etiketten med `bot.molt.<profile>` när du kör en namngiven profil.

## Övervakning (systemd användarenhet)

OpenClaw installerar en **systemd-användarservice** som standard på Linux/WSL2. Vi
rekommenderar användartjänster för enanvändarsmaskiner (enklare env, per-användarkonfiguration).
Använd en **systemtjänst** för flera användare eller alltid-på servrar (inga kvardröjande
krävs, delad övervakning).

`openclaw gateway install` skriver användarenheten. `openclaw doctor` granskar
enheten och kan uppdatera den för att matcha de rekommenderade standardinställningarna.

Skapa `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

Aktivera lingering (krävs för att användartjänsten ska överleva utloggning/inaktivitet):

```
sudo loginctl enable-linger youruser
```

Onboarding kör detta på Linux/WSL2 (kan be om sudo; skriv `/var/lib/systemd/linger`).
Aktivera sedan tjänsten:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternativ (systemservice)** - för alltid på eller fleranvändarservrar kan du
installera ett systemd **system** enhet istället för en användarenhet (ingen kvardröjande behov).
Skapa `/etc/systemd/system/openclaw-gateway[-<profile>].service` (kopiera enheten ovan,
switch `WantedBy=multi-user.target`, sätt `User=` + `WorkingDirectory=`), sedan:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows-installationer bör använda **WSL2** och följa Linux-avsnittet för systemd ovan.

## Operativa kontroller

- Liv: öppna WS och skicka `req:connect` → förvänta `res` med `payload.type="hello-ok"` (med ögonblicksbild).
- Beredskap: anropa `health` → förvänta `ok: true` och en länkad kanal i `linkChannel` (när tillämpligt).
- Debug: prenumerera på `tick`- och `presence`-händelser; säkerställ att `status` visar länk-/autentiseringsålder; närvaroposter visar Gateway-värd och anslutna klienter.

## Säkerhetsgarantier

- Anta en Gateway per värd som standard; om du kör flera profiler, isolera portar/tillstånd och rikta mot rätt instans.
- Ingen fallback till direkta Baileys-anslutningar; om Gateway är nere misslyckas sändningar snabbt.
- Icke-anslutningsförsta frames eller felaktig JSON avvisas och socketen stängs.
- Graciös avstängning: emittera `shutdown`-händelsen innan stängning; klienter måste hantera stängning + återanslutning.

## CLI-hjälpare

- `openclaw gateway health|status` — begär hälsa/status över Gateway-WS.
- `openclaw message send --target <num> --message "hi" [--media ...]` — skicka via Gateway (idempotent för WhatsApp).
- `openclaw agent --message "hi" --to <num>` — kör en agenttur (väntar på slutresultat som standard).
- `openclaw gateway call <method> --params '{"k":"v"}'` — rå metodanropare för felsökning.
- `openclaw gateway stop|restart` — stoppa/starta om den övervakade gateway-tjänsten (launchd/systemd).
- Gateway-hjälparunderkommandon förutsätter en körande gateway på `--url`; de startar inte längre automatiskt en.

## Migreringsvägledning

- Avveckla användning av `openclaw gateway` och den äldre TCP-kontrollporten.
- Uppdatera klienter till att tala WS-protokollet med obligatorisk anslutning och strukturerad närvaro.
