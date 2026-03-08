---
summary: "Remote access to MDM-managed Macs with Stealth Mode enabled using bore tunnels"
title: "MDM Stealth Mode Workaround"
---

# Remote Access to MDM-Managed Macs (Stealth Mode Workaround)

If your Mac is managed by MDM (like JAMF) with **Stealth Mode** enabled, you may find that SSH, VNC, and even Tailscale connections fail silently. This guide explains why and provides a working solution.

## The Problem

Stealth Mode drops ALL inbound packets silently — no ICMP, no port responses, nothing:

- ❌ SSH times out
- ❌ Tailscale can't route traffic
- ❌ Pings don't respond  
- ❌ Screen Sharing app shows nothing

Since Stealth Mode is MDM-enforced, you typically can't disable it.

## The Solution: Bore Tunnels

[Bore](https://github.com/ekzhang/bore) creates reverse tunnels — your Mac connects *outward* to a public relay server, and you connect to that relay to reach your Mac.

✅ Works with Stealth Mode (outbound connections are allowed)  
✅ Works from anywhere (not just local network)  
✅ Free to use (bore.pub is a public relay)

**How it works:**

```
Your Laptop → bore.pub:PORT → (tunnel) → Mac Mini
```

The Mac initiates the connection to bore.pub, so the firewall allows it.

## Prerequisites

- Homebrew installed on the target Mac
- One-time physical or existing remote access to set up the tunnel
- The Mac must stay powered on

## Quick Setup

### 1. Install bore

```bash
brew install bore-cli
```

### 2. Create tunnel scripts

```bash
mkdir -p ~/.local/bin

# SSH tunnel (port 22)
cat << 'SCRIPT' > ~/.local/bin/bore-tunnel.sh
#!/bin/bash
/opt/homebrew/bin/bore local 22 --to bore.pub
SCRIPT

# VNC/Screen Sharing tunnel (port 5900)
cat << 'SCRIPT' > ~/.local/bin/bore-vnc.sh
#!/bin/bash
/opt/homebrew/bin/bore local 5900 --to bore.pub
SCRIPT

chmod +x ~/.local/bin/bore-tunnel.sh ~/.local/bin/bore-vnc.sh
```

### 3. Create LaunchAgents (auto-start on boot)

The LaunchAgents capture bore output to log files so you can find the assigned ports.

**SSH LaunchAgent:**

```bash
cat << 'PLIST' > ~/Library/LaunchAgents/com.bore.ssh.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bore.ssh</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$HOME/.local/bin/bore-tunnel.sh</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/bore-ssh.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/bore-ssh.log</string>
</dict>
</plist>
PLIST
```

**VNC LaunchAgent:**

```bash
cat << 'PLIST' > ~/Library/LaunchAgents/com.bore.vnc.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bore.vnc</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>$HOME/.local/bin/bore-vnc.sh</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/bore-vnc.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/bore-vnc.log</string>
</dict>
</plist>
PLIST
```

### 4. Load the LaunchAgents

```bash
launchctl load ~/Library/LaunchAgents/com.bore.ssh.plist
launchctl load ~/Library/LaunchAgents/com.bore.vnc.plist
```

### 5. Get your ports

Ports are assigned randomly by bore.pub. Check the log files:

```bash
# SSH port
grep "listening at" /tmp/bore-ssh.log | tail -1

# VNC port  
grep "listening at" /tmp/bore-vnc.log | tail -1
```

Example output: `listening at bore.pub:17176`

### 6. Connect from anywhere

**SSH:**
```bash
ssh username@bore.pub -p PORT
```

**Screen Sharing:**
```bash
open vnc://bore.pub:PORT
```

## Tips

### Ports change on restart

The bore.pub relay assigns random ports each time. After a Mac restart, check the new ports via the log files.

If you have OpenClaw running on the Mac, you can ask it to check the current ports for you.

### For stable ports

- Self-host a [bore server](https://github.com/ekzhang/bore)
- Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) (free, stable hostnames)
- Use [ngrok](https://ngrok.com/) (free tier available)

### Enable Screen Sharing

Don't forget to enable Screen Sharing on the Mac:

**System Settings → General → Sharing → Screen Sharing → ON**

### Verify tunnels are running

```bash
launchctl list | grep bore
ps aux | grep bore
```

## Troubleshooting

**"bore: command not found"**  
Use the full path: `/opt/homebrew/bin/bore`

**Tunnel not starting**  
Check logs: `cat /tmp/bore-ssh.log`

**Can't connect**  
- Verify the port is correct (ports change on restart)
- Make sure Screen Sharing is enabled
- Check if bore process is running

## Why This Works

| Method | Stealth Mode | Result |
|--------|--------------|--------|
| Direct SSH | Blocked (inbound) | ❌ Timeout |
| Tailscale | Blocked (inbound routing) | ❌ Timeout |
| Local VNC | Blocked (inbound) | ❌ Nothing found |
| **Bore Tunnel** | Allowed (outbound) | ✅ Works! |

Stealth Mode blocks inbound packets but allows established outbound connections. Bore tunnels connect *outward* from your Mac to the relay, so traffic flows back through that allowed connection.
