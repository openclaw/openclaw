---
summary: "Windows support: native and WSL2 install paths, daemon, and current caveats"
read_when:
  - Installing OpenClaw on Windows
  - Choosing between native Windows and WSL2
  - Looking for Windows companion app status
title: "Windows"
---

# Windows

OpenClaw supports both **native Windows** and **WSL2**. WSL2 is the more
stable path and recommended for the full experience — the CLI, Gateway, and
tooling run inside Linux with full compatibility. Native Windows works for
core CLI and Gateway use, with some caveats noted below.

Native Windows companion apps are planned.

## WSL2 (recommended)

WSL2 (Windows Subsystem for Linux) provides the most stable and complete OpenClaw experience on Windows. It runs the full Linux version of OpenClaw inside a lightweight virtual machine.

### WSL2 Benefits

- Full compatibility with all OpenClaw features
- Better performance for most tasks
- Access to all Linux-based tools and dependencies
- More stable service management with systemd
- Consistent experience with Linux and macOS installations

### Quick WSL2 Setup

1. **Install WSL2** (PowerShell as Administrator):
   ```powershell
   wsl --install
   ```

2. **Enable systemd** (required for OpenClaw gateway):
   ```bash
   sudo tee /etc/wsl.conf >/dev/null <<'EOF'
   [boot]
   systemd=true
   EOF
   ```

3. **Restart WSL**:
   ```powershell
   wsl --shutdown
   ```

4. **Install OpenClaw** (inside WSL):
   ```bash
   pnpm add -g openclaw
   openclaw onboard
   ```

- [Getting Started](/start/getting-started) (use inside WSL)
- [Install & updates](/install/updating)
- Official WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Native Windows status

Native Windows support is improving, but WSL2 remains the recommended path for the complete OpenClaw experience.

### What Works Well on Native Windows

- **Basic CLI operations**: `openclaw --version`, `openclaw doctor`, `openclaw plugins list --json`
- **Local agent testing**: `openclaw agent --local --agent main --thinking low -m "Hello"`
- **Gateway functionality**: Core gateway operations work
- **Channel connections**: Most messaging channels work with appropriate configuration

### Current Native Windows Limitations

- **Service management**: Windows Scheduled Tasks are used instead of systemd
- **Some tools**: Certain Linux-specific tools may have limited functionality
- **Performance**: Some operations may be slower than on WSL2
- **Dependency management**: Some dependencies may require additional setup

### Native Windows Setup

1. **Install Node.js**: Download and install from [nodejs.org](https://nodejs.org/)
   - Recommended: Node 24 or Node 22.16+

2. **Install pnpm**: 
   ```powershell
   npm install -g pnpm
   ```

3. **Install OpenClaw**: 
   ```powershell
   pnpm add -g openclaw
   ```

4. **Run onboarding**: 
   ```powershell
   openclaw onboard
   ```

5. **Start gateway**: 
   ```powershell
   openclaw gateway start
   ```

### Native Windows Service Management

OpenClaw on native Windows uses Windows Scheduled Tasks for service management:

- **Install service**: `openclaw gateway install`
- **Check status**: `openclaw gateway status`
- **Start service**: `openclaw gateway start`
- **Stop service**: `openclaw gateway stop`

If Scheduled Task creation is denied, OpenClaw falls back to a per-user Startup-folder login item.

If you want the native CLI only, without gateway service install, use one of these:

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

If you do want managed startup on native Windows:

```powershell
openclaw gateway install
openclaw gateway status --json
```

If Scheduled Task creation is blocked, the fallback service mode still auto-starts after login through the current user's Startup folder.

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Inside WSL2:

```
openclaw onboard --install-daemon
```

Or:

```
openclaw gateway install
```

Or:

```
openclaw configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
openclaw doctor
```

## Gateway auto-start before Windows login

For headless setups, ensure the full boot chain runs even when no one logs into
Windows.

### 1) Keep user services running without login

Inside WSL:

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2) Install the OpenClaw gateway user service

Inside WSL:

```bash
openclaw gateway install
```

### 3) Start WSL automatically at Windows boot

In PowerShell as Administrator:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

Replace `Ubuntu` with your distro name from:

```powershell
wsl --list --verbose
```

### Verify startup chain

After a reboot (before Windows sign-in), check from WSL:

```bash
systemctl --user is-enabled openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager
```

## Advanced: expose WSL services over LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Example (PowerShell **as Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Allow the port through Windows Firewall (one-time):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Refresh the portproxy after WSL restarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notes:

- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use
  `openclaw status --all` to confirm.
- Use `listenaddress=0.0.0.0` for LAN access; `127.0.0.1` keeps it local only.
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

## Step-by-step WSL2 install

### 1) Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### 2) Enable systemd (required for gateway install)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### 3) Install OpenClaw (inside WSL)

Follow the Linux Getting Started flow inside WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Full guide: [Getting Started](/start/getting-started)

## Windows companion app

We do not have a Windows companion app yet. Contributions are welcome if you want
contributions to make it happen.
