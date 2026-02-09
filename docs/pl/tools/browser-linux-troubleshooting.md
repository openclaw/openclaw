---
summary: "„Naprawa problemów z uruchamianiem CDP Chrome/Brave/Edge/Chromium dla sterowania przeglądarką OpenClaw w systemie Linux”"
read_when: "„Sterowanie przeglądarką nie działa w systemie Linux, zwłaszcza z Chromium w snap”"
title: "„Rozwiązywanie problemów z przeglądarką”"
---

# Rozwiązywanie problemów z przeglądarką (Linux)

## Problem: „Failed to start Chrome CDP on port 18800”

Serwer sterowania przeglądarką OpenClaw nie uruchamia Chrome/Brave/Edge/Chromium i zgłasza błąd:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Przyczyna źródłowa

W Ubuntu (i wielu dystrybucjach Linuksa) domyślna instalacja Chromium jest **pakietem snap**. Ograniczenia AppArmor w snap kolidują ze sposobem, w jaki OpenClaw uruchamia i monitoruje proces przeglądarki.

Polecenie `apt install chromium` instaluje pakiet zastępczy, który przekierowuje do snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

To NIE jest prawdziwa przeglądarka — to tylko wrapper.

### Rozwiązanie 1: Zainstaluj Google Chrome (zalecane)

Zainstaluj oficjalny pakiet Google Chrome `.deb`, który nie jest objęty sandboxingiem snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Następnie zaktualizuj konfigurację OpenClaw (`~/.openclaw/openclaw.json`):

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

### Rozwiązanie 2: Użyj Chromium ze snap w trybie tylko dołączania

Jeśli musisz użyć Chromium ze snap, skonfiguruj OpenClaw tak, aby dołączał do ręcznie uruchomionej przeglądarki:

1. Zaktualizuj konfigurację:

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

2. Uruchom Chromium ręcznie:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Opcjonalnie utwórz usługę użytkownika systemd, aby automatycznie uruchamiać Chrome:

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

Włącz poleceniem: `systemctl --user enable --now openclaw-browser.service`

### Weryfikacja działania przeglądarki

Sprawdź status:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Przetestuj przeglądanie:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Referencja konfiguracji

| Opcja                    | Opis                                                                                                | Domyślne                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Włącza sterowanie przeglądarką                                                                      | `true`                                                                                               |
| `browser.executablePath` | Ścieżka do binarki przeglądarki opartej na Chromium (Chrome/Brave/Edge/Chromium) | automatycznie wykrywana (preferuje domyślną przeglądarkę, gdy oparta na Chromium) |
| `browser.headless`       | Uruchamianie bez GUI                                                                                | `false`                                                                                              |
| `browser.noSandbox`      | Dodaje flagę `--no-sandbox` (wymaganą w niektórych konfiguracjach Linuksa)       | `false`                                                                                              |
| `browser.attachOnly`     | Nie uruchamia przeglądarki, tylko dołącza do istniejącej                                            | `false`                                                                                              |
| `browser.cdpPort`        | Port Chrome DevTools Protocol                                                                       | `18800`                                                                                              |

### Problem: „Chrome extension relay is running, but no tab is connected”

Używasz profilu `chrome` (przekaźnik rozszerzenia). Oczekuje on, że rozszerzenie przeglądarki OpenClaw zostanie dołączone do aktywnej karty.

Opcje naprawy:

1. **Użyj przeglądarki zarządzanej:** `openclaw browser start --browser-profile openclaw`
   (lub ustaw `browser.defaultProfile: "openclaw"`).
2. **Użyj przekaźnika rozszerzenia:** zainstaluj rozszerzenie, otwórz kartę i kliknij ikonę rozszerzenia OpenClaw, aby je dołączyć.

Uwagi:

- Profil `chrome` używa, gdy to możliwe, **systemowej domyślnej przeglądarki Chromium**.
- Lokalne profile `openclaw` automatycznie przypisują `cdpPort`/`cdpUrl`; ustawiaj je tylko dla zdalnego CDP.
