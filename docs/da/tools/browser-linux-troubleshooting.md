---
summary: "Ret Chrome/Brave/Edge/Chromium CDP-opstartsproblemer for OpenClaw browserkontrol på Linux"
read_when: "Browserkontrol fejler på Linux, især med snap Chromium"
title: "Browser-fejlfinding"
---

# Browser-fejlfinding (Linux)

## Problem: "Failed to start Chrome CDP on port 18800"

OpenClaws browserkontrolserver kan ikke starte Chrome/Brave/Edge/Chromium med fejlen:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Rodårsag

På Ubuntu (og mange Linux-distros), er standard Chromium-installationen en **snap-pakke**. Snap's AppArmor indespærring forstyrrer hvordan OpenClaw spawns og overvåger browser processen.

Kommandoen `apt install chromium` installerer en stub-pakke, der omdirigerer til snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Dette er IKKE en rigtig browser — det er blot en wrapper.

### Løsning 1: Installér Google Chrome (Anbefalet)

Installér den officielle Google Chrome `.deb`-pakke, som ikke er sandboxed af snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Opdatér derefter din OpenClaw-konfiguration (`~/.openclaw/openclaw.json`):

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

### Løsning 2: Brug Snap Chromium med Attach-Only-tilstand

Hvis du er nødt til at bruge snap Chromium, så konfigurér OpenClaw til at tilknytte til en manuelt startet browser:

1. Opdatér konfiguration:

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

2. Start Chromium manuelt:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Opret eventuelt en systemd-brugertjeneste til automatisk at starte Chrome:

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

Aktivér med: `systemctl --user enable --now openclaw-browser.service`

### Verificér at browseren virker

Tjek status:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Test browsing:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Konfigurationsreference

| Option                   | Beskrivelse                                                                               | Standard                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Aktivér browserkontrol                                                                    | `true`                                                                                          |
| `browser.executablePath` | Sti til en Chromium-baseret browser-binær (Chrome/Brave/Edge/Chromium) | auto-detekteret (foretrækker standardbrowseren, når den er Chromium-baseret) |
| `browser.headless`       | Kør uden GUI                                                                              | `false`                                                                                         |
| `browser.noSandbox`      | Tilføj `--no-sandbox`-flag (nødvendigt for nogle Linux-opsætninger)    | `false`                                                                                         |
| `browser.attachOnly`     | Start ikke browseren, tilknyt kun til eksisterende                                        | `false`                                                                                         |
| `browser.cdpPort`        | Chrome DevTools Protocol-port                                                             | `18800`                                                                                         |

### Problem: "Chrome extension relay is running, but no tab is connected"

Du bruger 'chrome'-profilen (forlængelsesrelæ). Det forventer, at OpenClaw
browserudvidelsen skal være knyttet til en levende fane.

Løsningsmuligheder:

1. **Brug den administrerede browser:** `openclaw browser start --browser-profile openclaw`
   (eller sæt `browser.defaultProfile: "openclaw"`).
2. **Brug extension relay:** installér udvidelsen, åbn en fane, og klik på
   OpenClaw-udvidelsesikonet for at tilknytte den.

Noter:

- Profilen `chrome` bruger din **systemets standard Chromium-browser**, når det er muligt.
- Lokale `openclaw`-profiler tildeler automatisk `cdpPort`/`cdpUrl`; sæt kun disse for fjern-CDP.
