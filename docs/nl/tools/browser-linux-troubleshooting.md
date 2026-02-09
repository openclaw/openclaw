---
summary: "Los CDP-opstartproblemen van Chrome/Brave/Edge/Chromium op voor OpenClaw-browserbesturing op Linux"
read_when: "Browserbesturing faalt op Linux, vooral met snap Chromium"
title: "Problemen oplossen voor de browser"
---

# Problemen oplossen voor de browser (Linux)

## Probleem: "Failed to start Chrome CDP on port 18800"

De browserbesturingsserver van OpenClaw kan Chrome/Brave/Edge/Chromium niet starten met de fout:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Oorzaak

Op Ubuntu (en veel Linux-distributies) is de standaard Chromium-installatie een **snap-pakket**. De AppArmor-beperking van snap verstoort hoe OpenClaw het browserproces start en bewaakt.

De opdracht `apt install chromium` installeert een stubpakket dat doorverwijst naar snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Dit is GEEN echte browser — het is slechts een wrapper.

### Oplossing 1: Google Chrome installeren (aanbevolen)

Installeer het officiële Google Chrome `.deb`-pakket, dat niet door snap wordt gesandboxed:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Werk daarna je OpenClaw-config bij (`~/.openclaw/openclaw.json`):

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

### Oplossing 2: Snap Chromium gebruiken met Attach-Only-modus

Als je snap Chromium moet gebruiken, configureer OpenClaw dan om zich te koppelen aan een handmatig gestarte browser:

1. Config bijwerken:

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

2. Chromium handmatig starten:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Optioneel een systemd-gebruikersservice maken om Chrome automatisch te starten:

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

Inschakelen met: `systemctl --user enable --now openclaw-browser.service`

### Controleren of de browser werkt

Status controleren:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Browsen testen:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config-referentie

| Optie                    | Beschrijving                                                                                      | Standaard                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Browserbesturing inschakelen                                                                      | `true`                                                                                                            |
| `browser.executablePath` | Pad naar een op Chromium gebaseerde browserbinary (Chrome/Brave/Edge/Chromium) | automatisch gedetecteerd (geeft de voorkeur aan de standaardbrowser indien Chromium-gebaseerd) |
| `browser.headless`       | Zonder GUI uitvoeren                                                                              | `false`                                                                                                           |
| `browser.noSandbox`      | Voeg de vlag `--no-sandbox` toe (nodig voor sommige Linux-configuraties)       | `false`                                                                                                           |
| `browser.attachOnly`     | Browser niet starten, alleen koppelen aan een bestaande                                           | `false`                                                                                                           |
| `browser.cdpPort`        | Chrome DevTools Protocol-poort                                                                    | `18800`                                                                                                           |

### Probleem: "Chrome extension relay is running, but no tab is connected"

Je gebruikt het profiel `chrome` (extension relay). Dit verwacht dat de OpenClaw
browserextensie is gekoppeld aan een actieve tab.

Oplossingsopties:

1. **Gebruik de beheerde browser:** `openclaw browser start --browser-profile openclaw`
   (of stel `browser.defaultProfile: "openclaw"` in).
2. **Gebruik de extension relay:** installeer de extensie, open een tab en klik op het
   OpenClaw-extensie-icoon om deze te koppelen.

Notities:

- Het profiel `chrome` gebruikt waar mogelijk je **standaard Chromium-systeembrowser**.
- Lokale profielen `openclaw` wijzen automatisch `cdpPort`/`cdpUrl` toe; stel die alleen in voor externe CDP.
