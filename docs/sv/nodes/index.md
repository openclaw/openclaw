---
summary: "Noder: parning, funktioner, behörigheter och CLI-hjälpare för canvas/kamera/skärm/system"
read_when:
  - Para iOS/Android-noder till en gateway
  - Använda nodens canvas/kamera för agentkontext
  - Lägga till nya nodkommandon eller CLI-hjälpare
title: "Noder"
---

# Noder

En **node** är en kompanjonenhet (macOS/iOS/Android/headless) som ansluter till Gateway **WebSocket** (samma port som operatörer) med `roll: "node"` och exponerar en kommandoyta (e. . `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).

Äldre transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; utfasad/borttagen för nuvarande noder).

macOS kan också köras i **nodläge**: menyradsappen ansluter till Gatewayns WS-server och exponerar sina lokala canvas-/kamerakommandon som en nod (så att `openclaw nodes …` fungerar mot denna Mac).

Noteringar:

- Noder är **kringutrustning**, inte gateways. De kör inte gateway service.
- Telegram/WhatsApp/etc.-meddelanden hamnar på **gatewayen**, inte på noder.
- Felsökningsrunbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Parning + status

**WS-noder använder enhets parkoppling.** Noder presenterar en enhetsidentitet under `connect`; Gateway
skapar en enhets parkopplingsförfrågan för `roll: node`. Godkänn via enheterna CLI (eller UI).

Snabb CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Noteringar:

- `nodes status` markerar en nod som **parad** när dess enhetsparningsroll inkluderar `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) är ett separat gateway-ägt
  nodparningsregister; det spärrar **inte** WS-`connect`-handshaken.

## Fjärr-nodvärd (system.run)

Använd en **nod värd** när din Gateway körs på en maskin och du vill att kommandona
ska köras på en annan. Modellen talar fortfarande till **gateway**; gateway
framåt `exec` anrop till **nod värd** när `host=node` är vald.

### Vad körs var

- **Gateway-värd**: tar emot meddelanden, kör modellen, routar verktygsanrop.
- **Nodvärd**: kör `system.run`/`system.which` på nodmaskinen.
- **Godkännanden**: tillämpas på nodvärden via `~/.openclaw/exec-approvals.json`.

### Starta en nodvärd (förgrund)

På nodmaskinen:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Fjärr-gateway via SSH-tunnel (loopback-bindning)

Om Gateway binder till loopback (`gateway.bind=loopback`, standard i lokalt läge), kan
fjärrnodvärdar inte ansluta direkt. Skapa en SSH-tunnel och peka
nod värd i den lokala änden av tunneln.

Exempel (nodvärd -> gateway-värd):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Noteringar:

- Token är `gateway.auth.token` från gateway-konfigen (`~/.openclaw/openclaw.json` på gateway-värden).
- `openclaw node run` läser `OPENCLAW_GATEWAY_TOKEN` för autentisering.

### Starta en nodvärd (tjänst)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Para + namnge

På gateway-värden:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Namngivningsalternativ:

- `--display-name` på `openclaw node run` / `openclaw node install` (består i `~/.openclaw/node.json` på noden).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway-override).

### Tillåtelselista kommandona

Exec godkännanden är **per nod värd**. Lägg till tillåtna poster från gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Godkännanden lagras på nodvärden i `~/.openclaw/exec-approvals.json`.

### Peka exec mot noden

Konfigurera standarder (gateway-konfig):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Eller per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

När detta är satt körs varje `exec`-anrop med `host=node` på nodvärden (med förbehåll för
nodens tillåtelselista/godkännanden).

Relaterat:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Anropa kommandon

Lågnivå (rå RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Högre nivå-hjälpare finns för de vanliga arbetsflödena ”ge agenten en MEDIA-bilaga”.

## Skärmdumpar (canvas-ögonblicksbilder)

Om noden visar Canvas (WebView) returnerar `canvas.snapshot` `{ format, base64 }`.

CLI-hjälpare (skriver till en temporär fil och skriver ut `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas-kontroller

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Noteringar:

- `canvas present` accepterar URL:er eller lokala filsökvägar (`--target`), samt valfri `--x/--y/--width/--height` för positionering.
- `canvas eval` accepterar inbäddad JS (`--js`) eller ett positionsargument.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Noteringar:

- Endast A2UI v0.8 JSONL stöds (v0.9/createSurface avvisas).

## Foton + videor (nodkamera)

Foton (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Videoklipp (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Noteringar:

- Noden måste vara i **förgrunden** för `canvas.*` och `camera.*` (bakgrundsanrop returnerar `NODE_BACKGROUND_UNAVAILABLE`).
- Klipplängden begränsas (för närvarande `<= 60s`) för att undvika för stora base64-payloads.
- Android ber om behörigheter för `CAMERA`/`RECORD_AUDIO` när möjligt; nekade behörigheter misslyckas med `*_PERMISSION_REQUIRED`.

## Skärminspelningar (noder)

Noder exponerar `screen.record` (mp4). Exempel:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Noteringar:

- `screen.record` kräver att nodappen är i förgrunden.
- Android visar systemprompten för skärminspelning före inspelning.
- Skärminspelningar begränsas till `<= 60s`.
- `--no-audio` inaktiverar mikrofoninspelning (stöds på iOS/Android; macOS använder systemets inspelningsljud).
- Använd `--screen <index>` för att välja skärm när flera skärmar finns tillgängliga.

## Plats (noder)

Noder exponerar `location.get` när Plats är aktiverat i inställningarna.

CLI-hjälpare:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Noteringar:

- Plats är **avstängt som standard**.
- ”Alltid” kräver systembehörighet; bakgrundshämtning är bästa möjliga.
- Svaret inkluderar lat/long, noggrannhet (meter) och tidsstämpel.

## SMS (Android-noder)

Android-noder kan exponera `sms.send` när användaren beviljar **SMS**-behörighet och enheten stöder telefoni.

Lågnivåanrop:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Noteringar:

- Behörighetsprompten måste godkännas på Android-enheten innan funktionen annonseras.
- Enheter utan telefoni som endast har Wi‑Fi annonserar inte `sms.send`.

## Systemkommandon (nodvärd / mac-nod)

macOS noden exponerar `system.run`, `system.notify`, och `system.execApprovals.get/set`.
Den huvudlösa nodvärden exponerar `system.run`, `system.which`, och `system.execApprovals.get/set`.

Exempel:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Noteringar:

- `system.run` returnerar stdout/stderr/exitkod i payloaden.
- `system.notify` respekterar notifieringsbehörighetsstatus i macOS-appen.
- `system.run` stöder `--cwd`, `--env KEY=VAL`, `--command-timeout` och `--needs-screen-recording`.
- `system.notify` stöder `--priority <passive|active|timeSensitive>` och `--delivery <system|overlay|auto>`.
- macOS-noder ignorerar `PATH`-overrides; headless nodvärdar accepterar endast `PATH` när den prefixar nodvärdens PATH.
- På macOS node-läge är `system.run` gated av exec godkännanden i macOS appen (inställningar → Exec godkännanden).
  Från/allowlist/full beter sig som den huvudlösa noden värden; nekade uppmaningar tillbaka `SYSTEM_RUN_DENIED`.
- På headless nodvärd är `system.run` spärrat av exec-godkännanden (`~/.openclaw/exec-approvals.json`).

## Exec-nodbinding

När flera noder är tillgängliga kan du binda exec till en specifik nod.
Detta sätter standardnoden för `exec host=node` (och kan åsidosättas per agent).

Global standard:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Åsidosättning per agent:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Avaktivera för att tillåta vilken nod som helst:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Behörighetskarta

Noder kan inkludera en `permissions` karta i `node.list` / `node.describe`, tangentad med behörighetsnamn (t.ex. `screenRecording`, `accessibility`) med booleska värden (`true` = beviljad).

## Headless nodvärd (plattformsoavhängig)

OpenClaw kan köra en **huvudlös nodvärd** (inget UI) som ansluter till Gateway
WebSocket och exponerar `system.run` / `system.which`. Detta är användbart på Linux/Windows
eller för att köra en minimal nod tillsammans med en server.

Starta den:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Noteringar:

- Parning krävs fortfarande (Gatewayn visar en nodgodkännandeprompt).
- Nodvärden lagrar sitt nod-id, token, visningsnamn och gateway-anslutningsinfo i `~/.openclaw/node.json`.
- Exec-godkännanden tillämpas lokalt via `~/.openclaw/exec-approvals.json`
  (se [Exec approvals](/tools/exec-approvals)).
- På macOS, huvudlös nod värd föredrar följeslagare app exec värd när nås och faller
  tillbaka till lokal körning om appen inte är tillgänglig. Ställ in `OPENCLAW_NODE_EXEC_HOST=app` för att kräva
  appen, eller `OPENCLAW_NODE_EXEC_FALLBACK=0` för att inaktivera reserven.
- Lägg till `--tls` / `--tls-fingerprint` när Gateway WS använder TLS.

## Mac nodläge

- macOS-menyradsappen ansluter till Gatewayns WS-server som en nod (så att `openclaw nodes …` fungerar mot denna Mac).
- I fjärrläge öppnar appen en SSH-tunnel för Gateway-porten och ansluter till `localhost`.
