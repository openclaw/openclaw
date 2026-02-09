---
summary: "Åtgärda CDP-startproblem för Chrome/Brave/Edge/Chromium för OpenClaw webbläsarkontroll på Linux"
read_when: "Webbläsarkontroll misslyckas på Linux, särskilt med snap Chromium"
title: "Felsökning av webbläsare"
---

# Felsökning av webbläsare (Linux)

## Problem: "Failed to start Chrome CDP on port 18800"

OpenClaws server för webbläsarkontroll misslyckas med att starta Chrome/Brave/Edge/Chromium med felet:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Grundorsak

På Ubuntu (och många Linuxdistributioner) är standardinstallationen för Chromium ett **snap-paket**. Snap's AppArmor-inneslutning stör hur OpenClaw skapar och övervakar webbläsarprocessen.

Kommandot `apt install chromium` installerar ett stubbpaket som omdirigerar till snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Detta är INTE en riktig webbläsare — det är bara ett omslag.

### Lösning 1: Installera Google Chrome (rekommenderas)

Installera det officiella Google Chrome-`.deb`-paketet, som inte är sandboxat av snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Uppdatera sedan din OpenClaw-konfig (`~/.openclaw/openclaw.json`):

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

### Lösning 2: Använd Snap Chromium med endast-anslutningsläge

Om du måste använda snap Chromium, konfigurera OpenClaw att ansluta till en manuellt startad webbläsare:

1. Uppdatera konfig:

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

2. Starta Chromium manuellt:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Skapa valfritt en systemd-användartjänst för att starta Chrome automatiskt:

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

Aktivera med: `systemctl --user enable --now openclaw-browser.service`

### Verifiera att webbläsaren fungerar

Kontrollera status:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Testa surfning:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Konfigreferens

| Alternativ               | Beskrivning                                                                                    | Standard                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Aktivera webbläsarkontroll                                                                     | `true`                                                                                      |
| `browser.executablePath` | Sökväg till en Chromium-baserad webbläsarbinär (Chrome/Brave/Edge/Chromium) | auto-detected (föredrar standardwebbläsaren när den är Chromium-baserad) |
| `browser.headless`       | Kör utan GUI                                                                                   | `false`                                                                                     |
| `browser.noSandbox`      | Lägg till flaggan `--no-sandbox` (krävs för vissa Linux-uppsättningar)      | `false`                                                                                     |
| `browser.attachOnly`     | Starta inte webbläsaren, anslut endast till befintlig                                          | `false`                                                                                     |
| `browser.cdpPort`        | Port för Chrome DevTools Protocol                                                              | `18800`                                                                                     |

### Problem: "Chrome extension relay is running, but no tab is connected"

Du använder `chrome`-profilen (förlängningsrelä). Den förväntar sig att webbläsartillägget OpenClaw
ska anslutas till en live-flik.

Åtgärdsalternativ:

1. **Använd den hanterade webbläsaren:** `openclaw browser start --browser-profile openclaw`
   (eller ställ in `browser.defaultProfile: "openclaw"`).
2. **Använd tilläggsreläet:** installera tillägget, öppna en flik och klicka på
   OpenClaw-tilläggets ikon för att ansluta.

Noteringar:

- Profilen `chrome` använder din **systemets standard-Chromium-webbläsare** när det är möjligt.
- Lokala `openclaw`-profiler tilldelar automatiskt `cdpPort`/`cdpUrl`; ange dem endast för fjärr-CDP.
