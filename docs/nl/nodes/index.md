---
summary: "Nodes: koppelen, mogelijkheden, rechten en CLI-hulpprogramma’s voor canvas/camera/scherm/systeem"
read_when:
  - iOS/Android-nodes koppelen aan een gateway
  - Node-canvas/camera gebruiken voor agentcontext
  - Nieuwe node-opdrachten of CLI-hulpprogramma’s toevoegen
title: "Nodes"
---

# Nodes

Een **node** is een begeleidend apparaat (macOS/iOS/Android/headless) dat verbinding maakt met de Gateway **WebSocket** (dezelfde poort als operators) met `role: "node"` en een opdrachtoppervlak blootstelt (bijv. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Protocoldetails: [Gateway-protocol](/gateway/protocol).

Legacy-transport: [Bridge-protocol](/gateway/bridge-protocol) (TCP JSONL; verouderd/verwijderd voor huidige nodes).

macOS kan ook in **node-modus** draaien: de menubalk-app maakt verbinding met de WS-server van de Gateway en stelt zijn lokale canvas-/camera-opdrachten bloot als een node (zodat `openclaw nodes …` tegen deze Mac werkt).

Notities:

- Nodes zijn **randapparaten**, geen gateways. Ze draaien de gatewayservice niet.
- Telegram/WhatsApp/etc.-berichten komen aan op de **gateway**, niet op nodes.
- Runbook voor probleemoplossing: [/nodes/troubleshooting](/nodes/troubleshooting)

## Koppelen + status

**WS-nodes gebruiken apparaatkoppeling.** Nodes presenteren een apparaatidentiteit tijdens `connect`; de Gateway
maakt een apparaatkoppelingsverzoek aan voor `role: node`. Keur goed via de apparaten-CLI (of UI).

Snelle CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notities:

- `nodes status` markeert een node als **gekoppeld** wanneer zijn apparaatkoppelingsrol `node` bevat.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) is een aparte, door de gateway beheerde
  node-koppelingsopslag; deze blokkeert de WS-`connect`-handshake **niet**.

## Externe node-host (system.run)

Gebruik een **node-host** wanneer je Gateway op één machine draait en je opdrachten
op een andere wilt uitvoeren. Het model praat nog steeds met de **gateway**; de gateway
stuurt `exec`-aanroepen door naar de **node-host** wanneer `host=node` is geselecteerd.

### Wat draait waar

- **Gateway-host**: ontvangt berichten, draait het model, routeert tool-aanroepen.
- **Node-host**: voert `system.run`/`system.which` uit op de node-machine.
- **Goedkeuringen**: afgedwongen op de node-host via `~/.openclaw/exec-approvals.json`.

### Start een node-host (voorgrond)

Op de node-machine:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Externe gateway via SSH-tunnel (loopback-binding)

Als de Gateway aan loopback bindt (`gateway.bind=loopback`, standaard in lokale modus),
kunnen externe node-hosts niet direct verbinden. Maak een SSH-tunnel en richt de
node-host op het lokale uiteinde van de tunnel.

Voorbeeld (node-host -> gateway-host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notities:

- Het token is `gateway.auth.token` uit de gatewayconfig (`~/.openclaw/openclaw.json` op de gateway-host).
- `openclaw node run` leest `OPENCLAW_GATEWAY_TOKEN` voor authenticatie.

### Start een node-host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Koppelen + naam geven

Op de gateway-host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Naamgevingsopties:

- `--display-name` op `openclaw node run` / `openclaw node install` (blijft bewaard in `~/.openclaw/node.json` op de node).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway-override).

### Sta de opdrachten toe (allowlist)

Uitvoeringsgoedkeuringen zijn **per node-host**. Voeg allowlist-vermeldingen toe vanaf de gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Goedkeuringen leven op de node-host in `~/.openclaw/exec-approvals.json`.

### Richt exec naar de node

Configureer standaardwaarden (gatewayconfig):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Of per sessie:

```
/exec host=node security=allowlist node=<id-or-name>
```

Zodra ingesteld, wordt elke `exec`-aanroep met `host=node` uitgevoerd op de node-host (onder voorbehoud van de
node-allowlist/goedkeuringen).

Gerelateerd:

- [Node-host CLI](/cli/node)
- [Exec-tool](/tools/exec)
- [Exec-goedkeuringen](/tools/exec-approvals)

## Opdrachten inademen

Low-level (ruwe RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Er bestaan hulpprogramma’s op hoger niveau voor de veelvoorkomende workflows “geef de agent een MEDIA-bijlage”.

## Schermafbeeldingen (canvas-snapshots)

Als de node de Canvas toont (WebView), retourneert `canvas.snapshot` `{ format, base64 }`.

CLI-hulpprogramma (schrijft naar een tijdelijk bestand en print `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas-bediening

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notities:

- `canvas present` accepteert URL’s of lokale bestandspaden (`--target`), plus optionele `--x/--y/--width/--height` voor positionering.
- `canvas eval` accepteert inline JS (`--js`) of een positioneel argument.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notities:

- Alleen A2UI v0.8 JSONL wordt ondersteund (v0.9/createSurface wordt geweigerd).

## Foto’s + video’s (node-camera)

Foto’s (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Videoclips (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notities:

- De node moet **op de voorgrond** staan voor `canvas.*` en `camera.*` (achtergrondaanroepen retourneren `NODE_BACKGROUND_UNAVAILABLE`).
- Clipduur is begrensd (momenteel `<= 60s`) om te grote base64-payloads te voorkomen.
- Android vraagt waar mogelijk om `CAMERA`/`RECORD_AUDIO`-rechten; geweigerde rechten mislukken met `*_PERMISSION_REQUIRED`.

## Schermopnamen (nodes)

Nodes stellen `screen.record` bloot (mp4). Voorbeeld:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notities:

- `screen.record` vereist dat de node-app op de voorgrond staat.
- Android toont de systeemmelding voor schermopname vóór het opnemen.
- Schermopnamen zijn begrensd tot `<= 60s`.
- `--no-audio` schakelt microfoonopname uit (ondersteund op iOS/Android; macOS gebruikt systeemopname-audio).
- Gebruik `--screen <index>` om een display te selecteren wanneer meerdere schermen beschikbaar zijn.

## Locatie (nodes)

Nodes stellen `location.get` bloot wanneer Locatie is ingeschakeld in de instellingen.

CLI-hulpprogramma:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notities:

- Locatie staat **standaard uit**.
- “Altijd” vereist systeemtoestemming; ophalen op de achtergrond is best-effort.
- Het antwoord bevat lat/lon, nauwkeurigheid (meters) en tijdstempel.

## SMS (Android-nodes)

Android-nodes kunnen `sms.send` blootstellen wanneer de gebruiker **SMS**-toestemming verleent en het apparaat telefonie ondersteunt.

Low-level aanroep:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notities:

- De toestemmingsprompt moet op het Android-apparaat worden geaccepteerd voordat de mogelijkheid wordt geadverteerd.
- Apparaten zonder telefonie (alleen wifi) zullen `sms.send` niet adverteren.

## Systeemopdrachten (node-host / mac-node)

De macOS-node stelt `system.run`, `system.notify` en `system.execApprovals.get/set` bloot.
De headless node-host stelt `system.run`, `system.which` en `system.execApprovals.get/set` bloot.

Voorbeelden:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notities:

- `system.run` retourneert stdout/stderr/exitcode in de payload.
- `system.notify` respecteert de status van meldingsrechten in de macOS-app.
- `system.run` ondersteunt `--cwd`, `--env KEY=VAL`, `--command-timeout` en `--needs-screen-recording`.
- `system.notify` ondersteunt `--priority <passive|active|timeSensitive>` en `--delivery <system|overlay|auto>`.
- macOS-nodes laten `PATH`-overrides vallen; headless node-hosts accepteren `PATH` alleen wanneer deze het node-host-PATH voorafgaat.
- In macOS node-modus wordt `system.run` afgedwongen door exec-goedkeuringen in de macOS-app (Instellingen → Exec-goedkeuringen).
  Vragen/toegestane lijst/volledig gedragen zich hetzelfde als bij de headless node-host; geweigerde prompts retourneren `SYSTEM_RUN_DENIED`.
- Op de headless node-host wordt `system.run` afgedwongen door exec-goedkeuringen (`~/.openclaw/exec-approvals.json`).

## Exec node-binding

Wanneer meerdere nodes beschikbaar zijn, kun je exec aan een specifieke node binden.
Dit stelt de standaardnode in voor `exec host=node` (en kan per agent worden overschreven).

Globale standaard:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent-override:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Uitschakelen om elke node toe te staan:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Machtigingen kaart

Nodes kunnen een `permissions`-kaart opnemen in `node.list` / `node.describe`, gesleuteld op permissienaam (bijv. `screenRecording`, `accessibility`) met booleaanse waarden (`true` = verleend).

## Headless node-host (cross-platform)

OpenClaw kan een **headless node-host** (zonder UI) draaien die verbinding maakt met de Gateway
WebSocket en `system.run` / `system.which` blootstelt. Dit is nuttig op Linux/Windows
of voor het draaien van een minimale node naast een server.

Starten:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notities:

- Koppeling is nog steeds vereist (de Gateway toont een node-goedkeuringsprompt).
- De node-host slaat zijn node-id, token, weergavenaam en gatewayverbindingsinfo op in `~/.openclaw/node.json`.
- Exec-goedkeuringen worden lokaal afgedwongen via `~/.openclaw/exec-approvals.json`
  (zie [Exec-goedkeuringen](/tools/exec-approvals)).
- Op macOS geeft de headless node-host de voorkeur aan de exec-host van de companion-app wanneer bereikbaar en
  valt terug op lokale uitvoering als de app niet beschikbaar is. Stel `OPENCLAW_NODE_EXEC_HOST=app` in om
  de app te vereisen, of `OPENCLAW_NODE_EXEC_FALLBACK=0` om fallback uit te schakelen.
- Voeg `--tls` / `--tls-fingerprint` toe wanneer de Gateway-WS TLS gebruikt.

## Mac node-modus

- De macOS-menubalk-app maakt verbinding met de Gateway-WS-server als een node (zodat `openclaw nodes …` tegen deze Mac werkt).
- In externe modus opent de app een SSH-tunnel voor de Gateway-poort en verbindt met `localhost`.
