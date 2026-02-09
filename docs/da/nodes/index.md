---
summary: "Noder: parring, funktioner, tilladelser og CLI-hjælpere til canvas/kamera/skærm/system"
read_when:
  - Parring af iOS/Android-noder til en gateway
  - Brug af node-canvas/kamera til agentkontekst
  - Tilføjelse af nye node-kommandoer eller CLI-hjælpere
title: "Noder"
---

# Noder

A **node** er en følgesvend enhed (macOS/iOS/Android/headles), der forbinder til Gateway **WebSocket** (samme port som operatører) med `rolle: "node"` og udsætter en kommando overflade (f. eks. . `canvas.*`, `kamera.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).

Legacy-transport: [Bridge-protokol](/gateway/bridge-protocol) (TCP JSONL; forældet/fjernet for aktuelle noder).

macOS kan også køre i **node-tilstand**: menulinje-appen forbinder til Gateway’ens WS-server og eksponerer sine lokale canvas-/kamera-kommandoer som en node (så `openclaw nodes …` virker mod denne Mac).

Noter:

- Knuder er **perifere enheder**, ikke gateways. De kører ikke gateway service.
- Telegram/WhatsApp/etc.-beskeder lander på **gatewayen**, ikke på noder.
- Fejlsøgnings-runbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Parring + status

**WS noder bruger enhedsparring.** Nodes viser en enhedsidentitet under `connect`; Gateway
skaber en enheds parringsanmodning om `rolle: node`. Godkend via enhederne CLI (eller UI).

Hurtig CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Noter:

- `nodes status` markerer en node som **parret**, når dens enhedsparringsrolle inkluderer `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) er et separat gateway-ejet
  node-parringslager; det styrer **ikke** WS-`connect`-handshaken.

## Fjern node-vært (system.run)

Brug en \*\* node vært \*\* når din Gateway kører på en maskine og du vil have kommandoer
til at udføre på en anden. Modellen taler stadig til **gateway**; gateway
fremad `exec` opkald til **node vært** når `host=node` er valgt.

### Hvad kører hvor

- **Gateway-vært**: modtager beskeder, kører modellen, router værktøjskald.
- **Node-vært**: udfører `system.run`/`system.which` på node-maskinen.
- **Godkendelser**: håndhæves på node-værten via `~/.openclaw/exec-approvals.json`.

### Start en node-vært (forgrund)

På node-maskinen:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Fjern gateway via SSH-tunnel (loopback-bind)

Hvis Gateway binder til loopback (`gateway.bind=loopback`, standard i lokal tilstand), kan
remote node værter ikke forbinde direkte. Opret en SSH-tunnel og peg
-knudeværten i den lokale ende af tunnelen.

Eksempel (node-vært -> gateway-vært):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Noter:

- Tokenet er `gateway.auth.token` fra gateway-konfigurationen (`~/.openclaw/openclaw.json` på gateway-værten).
- `openclaw node run` læser `OPENCLAW_GATEWAY_TOKEN` til autentificering.

### Start en node-vært (tjeneste)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Par + navngiv

På gateway-værten:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Navngivningsmuligheder:

- `--display-name` på `openclaw node run` / `openclaw node install` (bevares i `~/.openclaw/node.json` på noden).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway-override).

### Tilladelsesliste for kommandoer

Exec godkendelser er **per node vært**. Tilføj tilladte indgange fra gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Godkendelser gemmes på node-værten i `~/.openclaw/exec-approvals.json`.

### Peg exec mod noden

Konfigurér standarder (gateway-konfiguration):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Eller pr. session:

```
/exec host=node security=allowlist node=<id-or-name>
```

Når det er sat, kører ethvert `exec`-kald med `host=node` på node-værten (underlagt
node-tilladelseslisten/godkendelser).

Relateret:

- [Node-vært CLI](/cli/node)
- [Exec-værktøj](/tools/exec)
- [Exec-godkendelser](/tools/exec-approvals)

## Kald af kommandoer

Lav-niveau (rå RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Der findes højere-niveau hjælpere til de almindelige arbejdsgange “giv agenten et MEDIE-vedhæft”.

## Skærmbilleder (canvas-snapshots)

Hvis noden viser Canvas (WebView), returnerer `canvas.snapshot` `{ format, base64 }`.

CLI-hjælper (skriver til en midlertidig fil og udskriver `MEDIA:<path>`):

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

Noter:

- `canvas present` accepterer URL’er eller lokale filstier (`--target`) samt valgfri `--x/--y/--width/--height` til positionering.
- `canvas eval` accepterer inline JS (`--js`) eller et positionsargument.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Noter:

- Kun A2UI v0.8 JSONL understøttes (v0.9/createSurface afvises).

## Fotos + videoer (node-kamera)

Fotos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Videoklip (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Noter:

- Noden skal være i **forgrunden** for `canvas.*` og `camera.*` (baggrundskald returnerer `NODE_BACKGROUND_UNAVAILABLE`).
- Kliplængde er begrænset (pt. `<= 60s`) for at undgå for store base64-payloads.
- Android vil bede om `CAMERA`/`RECORD_AUDIO`-tilladelser, når muligt; afviste tilladelser fejler med `*_PERMISSION_REQUIRED`.

## Skærmoptagelser (noder)

Knuder udsætter 'screen.record' (mp4). Eksempel:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Noter:

- `screen.record` kræver, at node-appen er i forgrunden.
- Android viser systemets prompt for skærmoptagelse før optagning.
- Skærmoptagelser er begrænset til `<= 60s`.
- `--no-audio` deaktiverer mikrofonoptagelse (understøttet på iOS/Android; macOS bruger systemets optagelseslyd).
- Brug `--screen <index>` til at vælge en skærm, når flere skærme er tilgængelige.

## Placering (noder)

Noder eksponerer `location.get`, når Placering er aktiveret i indstillingerne.

CLI-hjælper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Noter:

- Placering er **slået fra som standard**.
- “Altid” kræver systemtilladelse; baggrundshentning er best-effort.
- Svaret inkluderer lat/lon, nøjagtighed (meter) og tidsstempel.

## SMS (Android-noder)

Android-noder kan eksponere `sms.send`, når brugeren giver **SMS**-tilladelse, og enheden understøtter telefoni.

Lav-niveau kald:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Noter:

- Tilladelses-prompten skal accepteres på Android-enheden, før kapabiliteten annonceres.
- Wi‑Fi‑only enheder uden telefoni vil ikke annoncere `sms.send`.

## Systemkommandoer (node-vært / mac-node)

Den macOS node udsætter `system.run`, `system.notify`, og `system.execApprovals.get/set`.
Den hovedløse node vært udsætter `system.run`, `system.which`, og `system.execApprovals.get/set`.

Eksempler:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Noter:

- `system.run` returnerer stdout/stderr/exit-kode i payloaden.
- `system.notify` respekterer notifikationstilladelsens tilstand i macOS-appen.
- `system.run` understøtter `--cwd`, `--env KEY=VAL`, `--command-timeout` og `--needs-screen-recording`.
- `system.notify` understøtter `--priority <passive|active|timeSensitive>` og `--delivery <system|overlay|auto>`.
- macOS-noder ignorerer `PATH`-overrides; headless node-værter accepterer kun `PATH`, når det præfikser node-værtens PATH.
- På macOS node mode er `system.run` gated ved exec godkendelser i macOS app (Settings → Exec godkendelser).
  Ask/allowlist/full opfører sig på samme måde som den hovedløse node vært; nægtede beder returnere `SYSTEM_RUN_DENIED`.
- På headless node-vært er `system.run` styret af exec-godkendelser (`~/.openclaw/exec-approvals.json`).

## Exec node-binding

Når flere noder er tilgængelige, kan du binde exec til en bestemt node.
Dette sætter standardindholdselementet for 'exec host=node' (og kan tilsidesættes pr. agent).

Global standard:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Pr.-agent override:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Fjern binding for at tillade enhver node:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Tilladelseskort

Noder kan inkludere et `permissions`-kort i `node.list` / `node.describe`, nøglet efter tilladelsesnavn (fx `screenRecording`, `accessibility`) med boolske værdier (`true` = givet).

## Headless node-vært (på tværs af platforme)

OpenClaw kan køre en **headless node host** (no UI), der forbinder til Gateway
WebSocket og udsætter `system.run` / `system.which`. Dette er nyttigt på Linux/Windows
eller til at køre en minimal node sammen med en server.

Start den:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Noter:

- Parring er stadig påkrævet (Gateway vil vise en node-godkendelsesprompt).
- Node-værten gemmer sit node-id, token, visningsnavn og gateway-forbindelsesinfo i `~/.openclaw/node.json`.
- Exec-godkendelser håndhæves lokalt via `~/.openclaw/exec-approvals.json`
  (se [Exec-godkendelser](/tools/exec-approvals)).
- På macOS den hovedløse node vært foretrækker følgesvend app exec vært, når tilgængelig og falder
  tilbage til lokal udførelse, hvis app er utilgængelig. Sæt `OPENCLAW_NODE_EXEC_HOST=app` for at kræve
  appen, eller `OPENCLAW_NODE_EXEC_FALLBACK=0` for at deaktivere fallback.
- Tilføj `--tls` / `--tls-fingerprint`, når Gateway WS bruger TLS.

## Mac node-tilstand

- macOS-menulinje-appen forbinder til Gateway WS-serveren som en node (så `openclaw nodes …` virker mod denne Mac).
- I fjern-tilstand åbner appen en SSH-tunnel til Gateway-porten og forbinder til `localhost`.
