---
summary: "„Beheben von Chrome/Brave/Edge/Chromium-CDP-Startproblemen für die OpenClaw-Browsersteuerung unter Linux“"
read_when: "„Die Browsersteuerung schlägt unter Linux fehl, insbesondere mit Snap-Chromium“"
title: "„Browser-Fehlerbehebung“"
---

# Browser-Fehlerbehebung (Linux)

## Problem: „Failed to start Chrome CDP on port 18800“

Der Browsersteuerungsserver von OpenClaw kann Chrome/Brave/Edge/Chromium nicht starten und gibt folgenden Fehler aus:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Ursache

Unter Ubuntu (und vielen Linux-Distributionen) ist die Standardinstallation von Chromium ein **Snap-Paket**. Die AppArmor-Isolierung von Snap beeinträchtigt, wie OpenClaw den Browserprozess startet und überwacht.

Der Befehl `apt install chromium` installiert ein Stub-Paket, das zu Snap umleitet:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Dies ist **kein** echter Browser — es handelt sich lediglich um einen Wrapper.

### Lösung 1: Google Chrome installieren (Empfohlen)

Installieren Sie das offizielle Google-Chrome-`.deb`-Paket, das nicht durch Snap sandboxed ist:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Aktualisieren Sie anschließend Ihre OpenClaw-Konfiguration (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Lösung 2: Snap-Chromium mit Attach-Only-Modus verwenden

Wenn Sie Snap-Chromium verwenden müssen, konfigurieren Sie OpenClaw so, dass es sich an einen manuell gestarteten Browser anhängt:

1. Konfiguration aktualisieren:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium manuell starten:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Optional einen systemd-Benutzerdienst erstellen, um Chrome automatisch zu starten:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Aktivieren mit: `systemctl --user enable --now openclaw-browser.service`

### Überprüfen, ob der Browser funktioniert

Status prüfen:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Browsen testen:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Konfigurationsreferenz

| Option                   | Beschreibung                                                                                    | Standard                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Browsersteuerung aktivieren                                                                     | `true`                                                                                          |
| `browser.executablePath` | Pfad zu einem Chromium-basierten Browser-Binary (Chrome/Brave/Edge/Chromium) | automatisch erkannt (bevorzugt den Standardbrowser, sofern Chromium-basiert) |
| `browser.headless`       | Ohne GUI ausführen                                                                              | `false`                                                                                         |
| `browser.noSandbox`      | Flag `--no-sandbox` hinzufügen (für einige Linux-Setups erforderlich)        | `false`                                                                                         |
| `browser.attachOnly`     | Browser nicht starten, nur an einen bestehenden anhängen                                        | `false`                                                                                         |
| `browser.cdpPort`        | Chrome-DevTools-Protocol-Port                                                                   | `18800`                                                                                         |

### Problem: „Chrome extension relay is running, but no tab is connected“

Sie verwenden das Profil `chrome` (Extension Relay). Es erwartet, dass die OpenClaw-Browsererweiterung an einen aktiven Tab angehängt ist.

Lösungsoptionen:

1. **Den verwalteten Browser verwenden:** `openclaw browser start --browser-profile openclaw`
   (oder `browser.defaultProfile: "openclaw"` setzen).
2. **Das Extension Relay verwenden:** Installieren Sie die Erweiterung, öffnen Sie einen Tab und klicken Sie auf das OpenClaw-Erweiterungssymbol, um es anzuhängen.

Hinweise:

- Das Profil `chrome` verwendet nach Möglichkeit Ihren **systemweiten Standard-Chromium-Browser**.
- Lokale Profile `openclaw` weisen `cdpPort`/`cdpUrl` automatisch zu; setzen Sie diese nur für Remote-CDP.
