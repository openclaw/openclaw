---
summary: "Android-app (node): verbindingsrunbook + Canvas/Chat/Camera"
read_when:
  - Het koppelen of opnieuw verbinden van de Android-node
  - Het debuggen van Android Gateway-discovery of -authenticatie
  - Het verifiëren van chatgeschiedenis-pariteit tussen clients
title: "Android-app"
---

# Android-app (Node)

## Supportoverzicht

- Rol: companion node-app (Android host de Gateway niet).
- Gateway vereist: ja (draai deze op macOS, Linux of Windows via WSL2).
- Installatie: [Aan de slag](/start/getting-started) + [Koppelen](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Configuratie](/gateway/configuration).
  - Protocollen: [Gateway-protocol](/gateway/protocol) (nodes + control plane).

## Systeembeheer

Systeembeheer (launchd/systemd) bevindt zich op de Gateway-host. Zie [Gateway](/gateway).

## Verbindingsrunbook

Android-node-app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android verbindt direct met de Gateway WebSocket (standaard `ws://<host>:18789`) en gebruikt door de Gateway beheerde koppeling.

### Vereisten

- Je kunt de Gateway draaien op de “master”-machine.
- Android-apparaat/emulator kan de Gateway WebSocket bereiken:
  - Zelfde LAN met mDNS/NSD, **of**
  - Dezelfde Tailscale tailnet met Wide-Area Bonjour / unicast DNS-SD (zie hieronder), **of**
  - Handmatige gateway host/poort (fallback)
- Je kunt de CLI (`openclaw`) draaien op de gatewaymachine (of via SSH).

### 1. Start de Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Bevestig in de logs dat je iets ziet als:

- `listening on ws://0.0.0.0:18789`

Voor tailnet-only opstellingen (aanbevolen voor Wenen ⇄ Londen), bind de Gateway aan het tailnet-IP:

- Stel `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` in op de Gateway-host.
- Herstart de Gateway / macOS-menubalk-app.

### 2. Discovery verifiëren (optioneel)

Vanaf de gatewaymachine:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Meer debugnotities: [Bonjour](/gateway/bonjour).

#### Tailnet (Wenen ⇄ Londen) discovery via unicast DNS-SD

Android NSD/mDNS-discovery gaat niet over netwerken heen. Als je Android-node en de Gateway zich op verschillende netwerken bevinden maar via Tailscale verbonden zijn, gebruik dan Wide-Area Bonjour / unicast DNS-SD:

1. Zet een DNS-SD-zone op (bijvoorbeeld `openclaw.internal.`) op de Gateway-host en publiceer `_openclaw-gw._tcp`-records.
2. Configureer Tailscale split DNS voor je gekozen domein, verwijzend naar die DNS-server.

Details en voorbeeld CoreDNS-config: [Bonjour](/gateway/bonjour).

### 3. Verbinden vanaf Android

In de Android-app:

- De app houdt de gatewayverbinding actief via een **foreground service** (persistente notificatie).
- Open **Instellingen**.
- Selecteer onder **Ontdekte Gateways** je gateway en tik op **Verbinden**.
- Als mDNS geblokkeerd is, gebruik **Geavanceerd → Handmatige Gateway** (host + poort) en **Verbinden (handmatig)**.

Na de eerste succesvolle koppeling maakt Android bij het starten automatisch opnieuw verbinding:

- Handmatig eindpunt (indien ingeschakeld), anders
- De laatst ontdekte gateway (best effort).

### 4. Koppeling goedkeuren (CLI)

Op de gatewaymachine:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Koppelingsdetails: [Gateway-koppeling](/gateway/pairing).

### 5. Controleren of de node verbonden is

- Via nodes-status:

  ```bash
  openclaw nodes status
  ```

- Via de Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + geschiedenis

Het Chat-blad van de Android-node gebruikt de **primaire sessiesleutel** van de gateway (`main`), waardoor geschiedenis en antwoorden worden gedeeld met WebChat en andere clients:

- Geschiedenis: `chat.history`
- Verzenden: `chat.send`
- Push-updates (best effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + camera

#### Gateway Canvas Host (aanbevolen voor webcontent)

Als je wilt dat de node echte HTML/CSS/JS toont die de agent op schijf kan bewerken, wijs de node dan naar de Gateway canvas host.

Let op: nodes gebruiken de standalone canvas host op `canvasHost.port` (standaard `18793`).

1. Maak `~/.openclaw/workspace/canvas/index.html` aan op de Gateway-host.

2. Navigeer de node ernaartoe (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (optioneel): als beide apparaten op Tailscale zitten, gebruik een MagicDNS-naam of tailnet-IP in plaats van `.local`, bijv. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Deze server injecteert een live-reload-client in HTML en herlaadt bij bestandswijzigingen.
De A2UI-host bevindt zich op `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Canvas-opdrachten (alleen foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (gebruik `{"url":""}` of `{"url":"/"}` om terug te keren naar de standaard scaffold). `canvas.snapshot` retourneert `{ format, base64 }` (standaard `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy-alias)

Camera-opdrachten (alleen foreground; permissie-afhankelijk):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Zie [Camera-node](/nodes/camera) voor parameters en CLI-hulpmiddelen.
