---
summary: "Android-app (nod): anslutningsrunbook + Canvas/Chat/Kamera"
read_when:
  - Parkoppling eller återanslutning av Android-noden
  - Felsökning av Android-gatewayupptäckt eller autentisering
  - Verifiering av chathistorikparitet mellan klienter
title: "Android-app"
---

# Android App (Node)

## Supportöversikt

- Roll: companion-nodapp (Android är inte värd för Gateway).
- Gateway krävs: ja (kör den på macOS, Linux eller Windows via WSL2).
- Installera: [Kom igång](/start/getting-started) + [Parkoppling](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Konfiguration](/gateway/configuration).
  - Protokoll: [Gateway-protokoll](/gateway/protocol) (noder + kontrollplan).

## Systemkontroll

Systemkontroll (launchd/systemd) bor på Gateway-värden. Se [Gateway](/gateway).

## Anslutningsrunbook

Android-nodapp ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android ansluter direkt till Gateway WebSocket (standard `ws://<host>:18789`) och använder parkoppling som ägs av Gateway.

### Förutsättningar

- Du kan köra Gateway på ”master”-maskinen.
- Android-enhet/emulator kan nå gatewayns WebSocket:
  - Samma LAN med mDNS/NSD, **eller**
  - Samma Tailscale-tailnet med Wide-Area Bonjour / unicast DNS-SD (se nedan), **eller**
  - Manuell gateway-värd/port (reserv)
- Du kan köra CLI (`openclaw`) på gateway-maskinen (eller via SSH).

### 1. Starta Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Bekräfta i loggarna att du ser något i stil med:

- `listening on ws://0.0.0.0:18789`

För installationer som endast använder tailnet (rekommenderat för Wien ⇄ London), bind gatewayn till tailnet-IP:n:

- Sätt `gateway.bind: "tailnet"` i `~/.openclaw/openclaw.json` på gateway-värden.
- Starta om Gateway / macOS-menyradsappen.

### 2. Verifiera upptäckt (valfritt)

Från gateway-maskinen:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Fler felsökningsanteckningar: [Bonjour](/gateway/bonjour).

#### Tailnet-upptäckt (Wien ⇄ London) via unicast DNS-SD

Android NSD/mDNS upptäckten kommer inte korsa nätverk. Om din Android-nod och gateway är på olika nätverk men ansluten via Tailscale, använd Wide-Area Bonjour / unicast DNS-SD istället:

1. Sätt upp en DNS-SD-zon (exempel `openclaw.internal.`) på gateway-värden och publicera `_openclaw-gw._tcp`-poster.
2. Konfigurera Tailscale split DNS för din valda domän som pekar på den DNS-servern.

Detaljer och exempel på CoreDNS-konfig: [Bonjour](/gateway/bonjour).

### 3. Anslut från Android

I Android-appen:

- Appen håller sin gateway-anslutning vid liv via en **foreground service** (beständig notis).
- Öppna **Inställningar**.
- Under **Upptäckta Gateways**, välj din gateway och tryck **Anslut**.
- Om mDNS blockeras, använd **Avancerat → Manuell Gateway** (värd + port) och **Anslut (Manuell)**.

Efter den första lyckade parkopplingen återansluter Android automatiskt vid start:

- Manuell slutpunkt (om aktiverad), annars
- Den senast upptäckta gatewayn (best effort).

### 4. Godkänn parkoppling (CLI)

På gateway-maskinen:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Parkopplingsdetaljer: [Gateway-parkoppling](/gateway/pairing).

### 5. Verifiera att noden är ansluten

- Via nodstatus:

  ```bash
  openclaw nodes status
  ```

- Via Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chatt + historik

Android-nodens Chatt-vy använder gatewayns **primära sessionsnyckel** (`main`), så historik och svar delas med WebChat och andra klienter:

- Historik: `chat.history`
- Skicka: `chat.send`
- Push-uppdateringar (best effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + kamera

#### Gateway Canvas Host (rekommenderas för webbinnehåll)

Om du vill att noden ska visa riktig HTML/CSS/JS som agenten kan redigera på disk, peka noden mot Gateway canvas host.

Obs: noder använder den fristående canvas-värden på `canvasHost.port` (standard `18793`).

1. Skapa `~/.openclaw/workspace/canvas/index.html` på gateway-värden.

2. Navigera noden till den (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (valfritt): om båda enheterna är på Tailscale, använd ett MagicDNS-namn eller tailnet IP istället för `.local`, t.ex. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Denna server injicerar en live-reload-klient till HTML och laddar om filändringar.
A2UI-värden bor på `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Canvas-kommandon (endast foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (använd `{"url":""}` eller `{"url":"/"}` för att återgå till standardställningen). `canvas.snapshot` returnerar `{ format, base64 }` (standard `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` äldre alias)

Kamerakommandon (endast foreground; behörighetsstyrda):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Se [Camera node](/nodes/camera) för parametrar och CLI-hjälpmedel.
