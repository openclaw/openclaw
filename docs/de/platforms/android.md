---
summary: "Android-App (Node): Verbindungs-Runbook + Canvas/Chat/Kamera"
read_when:
  - Koppeln oder erneutes Verbinden des Android-Nodes
  - Debugging der Android-Gateway-Erkennung oder -Authentifizierung
  - Überprüfen der Chat-Verlaufsparität über Clients hinweg
title: "Android-App"
---

# Android-App (Node)

## Support-Übersicht

- Rolle: Companion-Node-App (Android hostet das Gateway nicht).
- Gateway erforderlich: ja (auf macOS, Linux oder Windows via WSL2 ausführen).
- Installation: [Erste Schritte](/start/getting-started) + [Pairing](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Konfiguration](/gateway/configuration).
  - Protokolle: [Gateway-Protokoll](/gateway/protocol) (Nodes + Control Plane).

## Systemsteuerung

Die Systemsteuerung (launchd/systemd) befindet sich auf dem Gateway-Host. Siehe [Gateway](/gateway).

## Verbindungs-Runbook

Android-Node-App ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android verbindet sich direkt mit dem Gateway-WebSocket (Standard `ws://<host>:18789`) und verwendet das vom Gateway verwaltete Pairing.

### Voraussetzungen

- Sie können das Gateway auf der „Master“-Maschine ausführen.
- Das Android-Gerät/der Emulator kann den Gateway-WebSocket erreichen:
  - Gleiches LAN mit mDNS/NSD, **oder**
  - Gleiches Tailscale-Tailnet mit Wide-Area Bonjour / unicast DNS-SD (siehe unten), **oder**
  - Manueller Gateway-Host/-Port (Fallback)
- Sie können die CLI (`openclaw`) auf der Gateway-Maschine ausführen (oder per SSH).

### 1. Gateway starten

```bash
openclaw gateway --port 18789 --verbose
```

Bestätigen Sie in den Logs, dass Sie etwa Folgendes sehen:

- `listening on ws://0.0.0.0:18789`

Für reine Tailnet-Setups (empfohlen für Wien ⇄ London) binden Sie das Gateway an die Tailnet-IP:

- Setzen Sie `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` auf dem Gateway-Host.
- Starten Sie das Gateway / die macOS-Menüleisten-App neu.

### 2. Discovery überprüfen (optional)

Von der Gateway-Maschine:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Weitere Debugging-Hinweise: [Bonjour](/gateway/bonjour).

#### Tailnet-(Wien ⇄ London)-Discovery via unicast DNS-SD

Android-NSD/mDNS-Discovery funktioniert nicht netzwerkübergreifend. Wenn sich Ihr Android-Node und das Gateway in unterschiedlichen Netzwerken befinden, aber über Tailscale verbunden sind, verwenden Sie stattdessen Wide-Area Bonjour / unicast DNS-SD:

1. Richten Sie auf dem Gateway-Host eine DNS-SD-Zone (Beispiel `openclaw.internal.`) ein und veröffentlichen Sie `_openclaw-gw._tcp`-Records.
2. Konfigurieren Sie Tailscale Split DNS für Ihre gewählte Domain, die auf diesen DNS-Server zeigt.

Details und Beispiel-CoreDNS-Konfiguration: [Bonjour](/gateway/bonjour).

### 3. Von Android verbinden

In der Android-App:

- Die App hält ihre Gateway-Verbindung über einen **Foreground-Service** (persistente Benachrichtigung) aufrecht.
- Öffnen Sie **Settings**.
- Wählen Sie unter **Discovered Gateways** Ihr Gateway aus und tippen Sie auf **Connect**.
- Wenn mDNS blockiert ist, verwenden Sie **Advanced → Manual Gateway** (Host + Port) und **Connect (Manual)**.

Nach dem ersten erfolgreichen Pairing verbindet sich Android beim Start automatisch erneut:

- Manueller Endpunkt (falls aktiviert), andernfalls
- Das zuletzt entdeckte Gateway (Best-Effort).

### 4. Pairing freigeben (CLI)

Auf der Gateway-Maschine:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Pairing-Details: [Gateway-Pairing](/gateway/pairing).

### 5. Prüfen, ob der Node verbunden ist

- Über den Node-Status:

  ```bash
  openclaw nodes status
  ```

- Über das Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + Verlauf

Das Chat-Panel des Android-Nodes verwendet den **primären Sitzungsschlüssel** des Gateways (`main`), sodass Verlauf und Antworten mit WebChat und anderen Clients geteilt werden:

- Verlauf: `chat.history`
- Senden: `chat.send`
- Push-Updates (Best-Effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + Kamera

#### Gateway Canvas Host (empfohlen für Webinhalte)

Wenn der Node echtes HTML/CSS/JS anzeigen soll, das der Agent auf der Festplatte bearbeiten kann, verweisen Sie den Node auf den Gateway-Canvas-Host.

Hinweis: Nodes verwenden den eigenständigen Canvas-Host auf `canvasHost.port` (Standard `18793`).

1. Erstellen Sie `~/.openclaw/workspace/canvas/index.html` auf dem Gateway-Host.

2. Navigieren Sie den Node dorthin (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (optional): Wenn beide Geräte über Tailscale verbunden sind, verwenden Sie einen MagicDNS-Namen oder eine Tailnet-IP statt `.local`, z. B. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Dieser Server injiziert einen Live-Reload-Client in HTML und lädt bei Dateiänderungen neu.
Der A2UI-Host befindet sich unter `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Canvas-Befehle (nur Foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (verwenden Sie `{"url":""}` oder `{"url":"/"}`, um zur Standard-Scaffold zurückzukehren). `canvas.snapshot` gibt `{ format, base64 }` zurück (Standard `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` Legacy-Alias)

Kamerabefehle (nur Foreground; berechtigungsabhängig):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Siehe [Camera node](/nodes/camera) für Parameter und CLI-Hilfen.
