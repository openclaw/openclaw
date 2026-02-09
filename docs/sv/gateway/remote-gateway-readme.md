---
summary: "SSH-tunnelkonfiguration för OpenClaw.app som ansluter till en fjärr-Gateway"
read_when: "Ansluta macOS-appen till en fjärr-Gateway över SSH"
title: "Konfigurering av fjärr-Gateway"
---

# Köra OpenClaw.app med en fjärr-Gateway

OpenClaw.app använder SSH-tunneln för att ansluta till en fjärr-gateway. Den här guiden visar hur du ställer in den.

## Översikt

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Snabbstart

### Steg 1: Lägg till SSH-konfig

Redigera `~/.ssh/config` och lägg till:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Ersätt `<REMOTE_IP>` och `<REMOTE_USER>` med dina värden.

### Steg 2: Kopiera SSH-nyckel

Kopiera din publika nyckel till fjärrmaskinen (ange lösenord en gång):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Steg 3: Ange Gateway-token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Steg 4: Starta SSH-tunnel

```bash
ssh -N remote-gateway &
```

### Steg 5: Starta om OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

Appen kommer nu att ansluta till fjärr-Gateway (nätverksgateway) via SSH-tunneln.

---

## Starta tunneln automatiskt vid inloggning

För att SSH-tunneln ska starta automatiskt när du loggar in, skapa en Launch Agent.

### Skapa PLIST-filen

Spara detta som `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Ladda Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Tunneln kommer nu att:

- Starta automatiskt när du loggar in
- Starta om om den kraschar
- Fortsätta köras i bakgrunden

Äldre notering: ta bort eventuell kvarvarande `com.openclaw.ssh-tunnel` LaunchAgent om den finns.

---

## Felsökning

**Kontrollera om tunneln körs:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Starta om tunneln:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Stoppa tunneln:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Hur det fungerar

| Komponent                            | Vad den gör                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Vidarebefordrar lokal port 18789 till fjärrport 18789                            |
| `ssh -N`                             | SSH utan att köra fjärrkommandon (endast portvidarebefordran) |
| `KeepAlive`                          | Startar automatiskt om tunneln om den kraschar                                   |
| `RunAtLoad`                          | Startar tunneln när agenten laddas                                               |

OpenClaw.app ansluter till `ws://127.0.0.1:18789` på din klientmaskin. SSH-tunneln framåt som ansluter till port 18789 på fjärrmaskinen där Gateway körs.
