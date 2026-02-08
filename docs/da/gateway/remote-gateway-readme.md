---
summary: "Opsætning af SSH-tunnel for OpenClaw.app, der forbinder til en fjern gateway"
read_when: "Tilslutning af macOS-appen til en fjern gateway via SSH"
title: "Opsætning af fjern Gateway"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:15Z
---

# Kørsel af OpenClaw.app med en fjern Gateway

OpenClaw.app bruger SSH-tunneling til at oprette forbindelse til en fjern gateway. Denne guide viser dig, hvordan du sætter det op.

## Overblik

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

## Hurtig opsætning

### Trin 1: Tilføj SSH-konfiguration

Redigér `~/.ssh/config` og tilføj:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Erstat `<REMOTE_IP>` og `<REMOTE_USER>` med dine værdier.

### Trin 2: Kopiér SSH-nøgle

Kopiér din offentlige nøgle til den fjerne maskine (indtast adgangskode én gang):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Trin 3: Sæt Gateway-token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### Trin 4: Start SSH-tunnel

```bash
ssh -N remote-gateway &
```

### Trin 5: Genstart OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

Appen vil nu oprette forbindelse til den fjerne gateway via SSH-tunnelen.

---

## Automatisk start af tunnel ved login

For at få SSH-tunnelen til at starte automatisk, når du logger ind, skal du oprette en Launch Agent.

### Opret PLIST-filen

Gem dette som `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

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

### Indlæs Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

Tunnelen vil nu:

- Starte automatisk, når du logger ind
- Genstarte, hvis den crasher
- Køre videre i baggrunden

Legacy-note: fjern eventuelle resterende `com.openclaw.ssh-tunnel` LaunchAgent, hvis de findes.

---

## Fejlfinding

**Tjek om tunnelen kører:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Genstart tunnelen:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**Stop tunnelen:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## Sådan virker det

| Komponent                            | Hvad den gør                                             |
| ------------------------------------ | -------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | Videresender lokal port 18789 til fjern port 18789       |
| `ssh -N`                             | SSH uden at udføre fjernkommandoer (kun port forwarding) |
| `KeepAlive`                          | Genstarter automatisk tunnelen, hvis den crasher         |
| `RunAtLoad`                          | Starter tunnelen, når agenten indlæses                   |

OpenClaw.app opretter forbindelse til `ws://127.0.0.1:18789` på din klientmaskine. SSH-tunnelen videresender den forbindelse til port 18789 på den fjerne maskine, hvor Gateway kører.
