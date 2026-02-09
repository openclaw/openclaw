---
summary: "Android-app (node): forbindelses-runbook + Canvas/Chat/Kamera"
read_when:
  - Parring eller genforbindelse af Android-noden
  - Fejlfinding af Android gateway-discovery eller autentificering
  - Verificering af chat-historikparitet på tværs af klienter
title: "Android-app"
---

# Android-app (Node)

## Supportoversigt

- Rolle: companion node-app (Android hoster ikke Gateway).
- Gateway påkrævet: ja (kør den på macOS, Linux eller Windows via WSL2).
- Installér: [Kom godt i gang](/start/getting-started) + [Parring](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Konfiguration](/gateway/configuration).
  - Protokoller: [Gateway-protokol](/gateway/protocol) (noder + kontrolplan).

## Systemkontrol

Systemkontrol (launchd/systemd) lever på Gateway værten. Se [Gateway](/gateway).

## Forbindelses-runbook

Android node-app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android forbinder direkte til Gateway WebSocket (standard `ws://<host>:18789`) og bruger Gateway-ejet parring.

### Forudsætninger

- Du kan køre Gateway på “master”-maskinen.
- Android-enhed/emulator kan nå gatewayens WebSocket:
  - Samme LAN med mDNS/NSD, **eller**
  - Samme Tailscale tailnet med Wide-Area Bonjour / unicast DNS-SD (se nedenfor), **eller**
  - Manuel gateway-vært/port (fallback)
- Du kan køre CLI (`openclaw`) på gateway-maskinen (eller via SSH).

### 1. Start Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Bekræft i logs, at du ser noget i stil med:

- `listening on ws://0.0.0.0:18789`

For tailnet-only-opsætninger (anbefalet til Wien ⇄ London), bind gatewayen til tailnet-IP’en:

- Sæt `gateway.bind: "tailnet"` i `~/.openclaw/openclaw.json` på gateway-værten.
- Genstart Gateway / macOS-menulinjeappen.

### 2. Verificér discovery (valgfrit)

Fra gateway-maskinen:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Flere debug-noter: [Bonjour](/gateway/bonjour).

#### Tailnet (Wien ⇄ London) discovery via unicast DNS-SD

Android NSD / mDNS opdagelse vil ikke krydse netværk. Hvis din Android-node og gatewayen er på forskellige netværk, men tilsluttet via Tailscale, skal du bruge Wide-Area Bonjour / unicast DNS-SD i stedet:

1. Opsæt en DNS-SD-zone (eksempel `openclaw.internal.`) på gateway-værten og publicér `_openclaw-gw._tcp`-records.
2. Konfigurér Tailscale split DNS for dit valgte domæne, der peger på den DNS-server.

Detaljer og eksempel på CoreDNS-konfiguration: [Bonjour](/gateway/bonjour).

### 3. Forbind fra Android

I Android-appen:

- Appen holder sin gateway-forbindelse i live via en **foreground service** (vedvarende notifikation).
- Åbn **Settings**.
- Under **Discovered Gateways**, vælg din gateway og tryk **Connect**.
- Hvis mDNS er blokeret, brug **Advanced → Manual Gateway** (vært + port) og **Connect (Manual)**.

Efter den første vellykkede parring genforbinder Android automatisk ved opstart:

- Manuel endpoint (hvis aktiveret), ellers
- Den sidst opdagede gateway (best-effort).

### 4. Godkend parring (CLI)

På gateway-maskinen:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Parringsdetaljer: [Gateway-parring](/gateway/pairing).

### 5. Verificér at noden er forbundet

- Via nodestatus:

  ```bash
  openclaw nodes status
  ```

- Via Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + historik

Android-nodens Chat-ark bruger gatewayens **primære sessionsnøgle** (`main`), så historik og svar deles med WebChat og andre klienter:

- Historik: `chat.history`
- Send: `chat.send`
- Push-opdateringer (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + kamera

#### Gateway Canvas Host (anbefalet til webindhold)

Hvis du vil have noden til at vise rigtig HTML/CSS/JS, som agenten kan redigere på disk, så peg noden mod Gateway canvas host.

Bemærk: noder bruger den standalone canvas host på `canvasHost.port` (standard `18793`).

1. Opret `~/.openclaw/workspace/canvas/index.html` på gateway-værten.

2. Navigér noden til den (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (valgfri): Hvis begge enheder er på Tailscale, skal du bruge et MagicDNS-navn eller tailnet IP i stedet for `.local`, f.eks. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Denne server tilfører en live-reload klient til HTML og genindlæses på filændringer.
A2UI-værten bor på `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Canvas-kommandoer (kun foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (brug `{"url":""}` eller `{"url":"/"}` for at vende tilbage til standardstilladsen). `canvas.snapshot` returnerer `{ format, base64 }` (standard `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy-alias)

Kamera-kommandoer (kun foreground; tilladelsesstyret):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Se [Camera node](/nodes/camera) for parametre og CLI-hjælpere.
