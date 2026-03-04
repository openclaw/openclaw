---
summary: "Windows support (WSL2 recommended, native experimental) + companion app status"
read_when:
  - Installing OpenClaw on Windows
  - Looking for Windows companion app status
title: "Windows"
---

# Windows

OpenClaw on Windows is recommended **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent and makes
tooling far more compatible (Node/Bun/pnpm, Linux binaries, skills). Native
Windows might be trickier. WSL2 gives you the full Linux experience — one command
to install: `wsl --install`.

Native Windows companion apps are planned.

## Native Windows (experimental)

WSL2 remains the recommended path, but the CLI + Gateway can also run natively on Windows for single-host setups.

### Minimal native setup

1. Install Node 22+ and pnpm on Windows.
2. Install OpenClaw globally (`npm i -g openclaw`).
3. Run onboarding/configuration (`openclaw onboard` or `openclaw configure`).
4. Install/start the Gateway service:

```powershell
openclaw gateway install
openclaw gateway start
openclaw gateway status
```

On native Windows, `gateway install` uses **Task Scheduler** (`schtasks`) for service supervision.

### PowerShell gotchas

- In Windows PowerShell 5.1, `&&` is not valid; use `;` or separate commands.
- Avoid duplicate starts: check whether port `18789` is already listening before launching another foreground gateway process.
- OAuth/setup-token auth (for example `sk-ant-oat01-*`) works natively on Windows.

### Task Scheduler and NSSM

- Prefer one supervisor only. Task Scheduler is the default path used by OpenClaw.
- Do not run NSSM and Task Scheduler for the same gateway at the same time.
- If you switch supervisors, stop/disable the old one first to avoid duplicate gateway processes.

## Install (WSL2)

- [Getting Started](/start/getting-started) (use inside WSL)
- [Install & updates](/install/updating)
- Official WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

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
systemctl --user is-enabled openclaw-gateway
systemctl --user status openclaw-gateway --no-pager
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
