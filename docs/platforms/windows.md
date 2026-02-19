---
summary: "Windows (WSL2) support + companion app status"
read_when:
  - Installing OpenClaw on Windows
  - Looking for Windows companion app status
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw on Windows is recommended **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent and makes
tooling far more compatible (Node/Bun/pnpm, Linux binaries, skills). Native
Windows might be trickier. WSL2 gives you the full Linux experience — one command
to install: `wsl --install`.

Native Windows companion apps are planned.

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
- The WSL IP changes after restarts. See [Automate portproxy refresh](#automate-portproxy-refresh-scheduled-task) for persistent forwarding.

## Automate portproxy refresh (Scheduled Task)

Since WSL's IP address changes on restart, you can automate the port forwarding refresh using a Windows Scheduled Task.

### Create the refresh script

Save this as `C:\Scripts\Refresh-WSL-Portproxy.ps1` (create the `Scripts` folder if needed):

```powershell
# Refresh-WSL-Portproxy.ps1
# Refreshes port forwarding from Windows to WSL after WSL IP changes

param(
    [string]$Distro = "Ubuntu-24.04",
    [int]$ListenPort = 2222,
    [int]$TargetPort = 22
)

# Get current WSL IP
$WslIp = (wsl -d $Distro -- hostname -I 2>$null).Trim().Split(" ")[0]

if (-not $WslIp) {
    Write-Warning "Could not retrieve WSL IP for distro '$Distro'. Is WSL running?"
    exit 1
}

Write-Host "WSL IP detected: $WslIp"

# Remove existing rule (if any)
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 2>$null | Out-Null

# Add new rule with current WSL IP
netsh interface portproxy add v4tov4 `
    listenaddress=0.0.0.0 `
    listenport=$ListenPort `
    connectaddress=$WslIp `
    connectport=$TargetPort

if ($LASTEXITCODE -eq 0) {
    Write-Host "Port forwarding updated: 0.0.0.0:$ListenPort -> $WslIp:$TargetPort"
} else {
    Write-Error "Failed to update port forwarding."
    exit 1
}
```

### Register the Scheduled Task

Run this in PowerShell **as Administrator** to create a task that runs at login and every 30 minutes:

```powershell
$TaskName = "Refresh-WSL-Portproxy"
$ScriptPath = "C:\Scripts\Refresh-WSL-Portproxy.ps1"
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

# Build the action
$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Distro `"$Distro`" -ListenPort $ListenPort -TargetPort $TargetPort"

# Trigger: at login + every 30 minutes
$TriggerLogin = New-ScheduledTaskTrigger -AtLogOn
$TriggerInterval = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration ([TimeSpan]::MaxValue)

# Run as SYSTEM with highest privileges
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Settings
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Register the task
Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $TriggerLogin,$TriggerInterval `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Automatically refreshes port forwarding from Windows to WSL when IP changes" `
    -Force

Write-Host "Scheduled Task '$TaskName' created successfully."
Write-Host "To test manually: Start-ScheduledTask -TaskName '$TaskName'"
```

### Verify the setup

Check that the task is registered:

```powershell
Get-ScheduledTask -TaskName "Refresh-WSL-Portproxy"
```

Test the task manually:

```powershell
Start-ScheduledTask -TaskName "Refresh-WSL-Portproxy"
```

Verify port forwarding is active:

```powershell
netsh interface portproxy show v4tov4
```

You should see your forwarding rule listed with the current WSL IP.

### For OpenClaw Gateway forwarding

If you want to expose the OpenClaw Gateway (default port `18789`) to your LAN, modify the script parameters:

```powershell
# When registering the task, use:
$ListenPort = 18789
$TargetPort = 18789
```

Then access the Gateway from another machine at `http://<windows-host-ip>:18789/`.

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
to help make it happen.
