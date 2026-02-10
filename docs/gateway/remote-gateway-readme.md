---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "SSH tunnel setup for OpenClaw.app connecting to a remote gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "Connecting the macOS app to a remote gateway over SSH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Remote Gateway Setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Running OpenClaw.app with a Remote Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw.app uses SSH tunneling to connect to a remote gateway. This guide shows you how to set it up.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```mermaid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
%%{init: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'theme': 'base',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'themeVariables': {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryTextColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'primaryBorderColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'lineColor': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'secondaryColor': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'tertiaryColor': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBkg': '#f9f9fb',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'clusterBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'nodeBorder': '#000000',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'mainBkg': '#ffffff',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'edgeLabelBackground': '#ffffff'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}}%%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flowchart TB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    subgraph Client["Client Machine"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        direction TB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        A["OpenClaw.app"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        B["ws://127.0.0.1:18789\n(local port)"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        T["SSH Tunnel"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        A --> B（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        B --> T（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    subgraph Remote["Remote Machine"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        direction TB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        C["Gateway WebSocket"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        D["ws://127.0.0.1:18789"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        C --> D（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    end（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    T --> C（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 1: Add SSH Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit `~/.ssh/config` and add:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ssh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Host remote-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    HostName <REMOTE_IP>          # e.g., 172.27.187.184（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    User <REMOTE_USER>            # e.g., jefferson（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    LocalForward 18789 127.0.0.1:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    IdentityFile ~/.ssh/id_rsa（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replace `<REMOTE_IP>` and `<REMOTE_USER>` with your values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 2: Copy SSH Key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copy your public key to the remote machine (enter password once):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 3: Set Gateway Token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 4: Start SSH Tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -N remote-gateway &（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 5: Restart OpenClaw.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Quit OpenClaw.app (⌘Q), then reopen:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open /path/to/OpenClaw.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The app will now connect to the remote gateway through the SSH tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-Start Tunnel on Login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To have the SSH tunnel start automatically when you log in, create a Launch Agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Create the PLIST file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Save this as `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```xml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<?xml version="1.0" encoding="UTF-8"?>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<plist version="1.0">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>Label</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>bot.molt.ssh-tunnel</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>ProgramArguments</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <string>/usr/bin/ssh</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <string>-N</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <string>remote-gateway</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>KeepAlive</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>RunAtLoad</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</plist>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Load the Launch Agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The tunnel will now:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start automatically when you log in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart if it crashes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep running in the background（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy note: remove any leftover `com.openclaw.ssh-tunnel` LaunchAgent if present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check if tunnel is running:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ps aux | grep "ssh -N remote-gateway" | grep -v grep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lsof -i :18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Restart the tunnel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Stop the tunnel:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl bootout gui/$UID/bot.molt.ssh-tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Component                            | What It Does                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------ | ------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `LocalForward 18789 127.0.0.1:18789` | Forwards local port 18789 to remote port 18789               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `ssh -N`                             | SSH without executing remote commands (just port forwarding) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `KeepAlive`                          | Automatically restarts tunnel if it crashes                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `RunAtLoad`                          | Starts tunnel when the agent loads                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw.app connects to `ws://127.0.0.1:18789` on your client machine. The SSH tunnel forwards that connection to port 18789 on the remote machine where the Gateway is running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
