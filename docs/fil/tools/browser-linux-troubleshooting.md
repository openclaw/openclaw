---
summary: "Ayusin ang mga isyu sa pagsisimula ng Chrome/Brave/Edge/Chromium CDP para sa kontrol ng browser ng OpenClaw sa Linux"
read_when: "Nabibigo ang kontrol ng browser sa Linux, lalo na kapag snap Chromium ang gamit"
title: "Pag-troubleshoot ng Browser"
---

# Pag-troubleshoot ng Browser (Linux)

## Problema: "Failed to start Chrome CDP on port 18800"

Nabibigo ang browser control server ng OpenClaw na ilunsad ang Chrome/Brave/Edge/Chromium na may error:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Root Cause

21. Sa Ubuntu (at maraming Linux distro), ang default na instalasyon ng Chromium ay isang **snap package**. 22. Ang AppArmor confinement ng Snap ay nakikialam sa paraan ng OpenClaw sa pag-spawn at pag-monitor ng browser process.

Ini-install ng `apt install chromium` na command ang isang stub package na nagre-redirect sa snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

HINDI ito isang totoong browser — wrapper lang ito.

### Solusyon 1: I-install ang Google Chrome (Inirerekomenda)

I-install ang opisyal na Google Chrome `.deb` package, na hindi sandboxed ng snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Pagkatapos, i-update ang OpenClaw config mo (`~/.openclaw/openclaw.json`):

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

### Solusyon 2: Gamitin ang Snap Chromium gamit ang Attach-Only Mode

Kung kailangan mong gumamit ng snap Chromium, i-configure ang OpenClaw para kumabit sa isang manu-manong sinimulang browser:

1. I-update ang config:

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

2. Simulan ang Chromium nang manu-mano:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Opsyonal na gumawa ng systemd user service para auto-start ang Chrome:

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

I-enable gamit ang: `systemctl --user enable --now openclaw-browser.service`

### Pag-verify na Gumagana ang Browser

Suriin ang status:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Subukan ang pagba-browse:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Sanggunian ng Config

| Option                   | Description                                                                                            | Default                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `browser.enabled`        | I-enable ang kontrol ng browser                                                                        | `true`                                                                                      |
| `browser.executablePath` | Path papunta sa isang Chromium-based na browser binary (Chrome/Brave/Edge/Chromium) | auto-detected (mas pinipili ang default na browser kapag Chromium-based) |
| `browser.headless`       | Patakbuhin nang walang GUI                                                                             | `false`                                                                                     |
| `browser.noSandbox`      | Idagdag ang `--no-sandbox` flag (kailangan para sa ilang Linux setup)               | `false`                                                                                     |
| `browser.attachOnly`     | Huwag ilunsad ang browser, kumabit lang sa umiiral                                                     | `false`                                                                                     |
| `browser.cdpPort`        | Port ng Chrome DevTools Protocol                                                                       | `18800`                                                                                     |

### Problema: "Chrome extension relay is running, but no tab is connected"

23. Ginagamit mo ang `chrome` profile (extension relay). 24. Inaasahan nitong nakakabit ang OpenClaw browser extension sa isang live na tab.

Mga opsyon sa pag-aayos:

1. **Gamitin ang managed browser:** `openclaw browser start --browser-profile openclaw`
   (o itakda ang `browser.defaultProfile: "openclaw"`).
2. **Gamitin ang extension relay:** i-install ang extension, magbukas ng tab, at i-click ang
   OpenClaw extension icon para ikabit ito.

Mga tala:

- Ginagamit ng `chrome` na profile ang **system default na Chromium browser** kapag posible.
- Ang mga lokal na `openclaw` na profile ay auto-assign ng `cdpPort`/`cdpUrl`; itakda lang ang mga iyon para sa remote CDP.
