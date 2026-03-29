---
summary: "Windows quickstart for WSL2 and native installs, gateway lifecycle, logs, and the tray companion"
read_when:
  - Installing OpenClaw on Windows
  - Choosing between WSL2 and native Windows
  - Running or troubleshooting the Windows tray companion
title: "Windows"
---

# Windows

OpenClaw supports both **WSL2** and **native Windows**.

- **Recommended path:** WSL2 for the most predictable Gateway service behavior.
- **Supported path:** native Windows for CLI flows, Gateway lifecycle control, doctor output, and the Windows tray companion MVP.

Use this page to pick a path, install OpenClaw, verify status, and recover from the most common Windows failures.

For the deeper recovery runbook, see [Windows troubleshooting](/platforms/windows-troubleshooting).

## Choose your install path

### Use WSL2 when you want the full Gateway host experience

Choose WSL2 if you want:

- Linux-compatible service behavior
- `systemd` user services
- the lowest-friction path for long-running Gateway hosts
- the same install flow as Linux docs

### Use native Windows when you want the CLI and tray companion

Choose native Windows if you want:

- the website installer and regular `openclaw` CLI commands
- native `openclaw doctor` and `openclaw gateway ...` lifecycle control
- the Windows tray companion MVP
- a per-user background Gateway on Windows without moving into WSL2

Native Windows is narrower than WSL2. If you hit service-supervision or boot-chain problems, move to WSL2 instead of fighting the OS.

## Quickstart with WSL2

### 1. Install WSL2

Open an elevated PowerShell window and run:

```powershell
wsl --install
```

If you want a specific distro:

```powershell
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Expected result:

```text
The requested operation is successful. Changes will not be effective until the system is rebooted.
```

What to do next:

- Reboot Windows if prompted.
- Launch the distro once so first-run setup can complete.

### 2. Enable systemd inside WSL

Inside the WSL terminal:

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

Verify after reopening WSL:

```bash
systemctl --user status
```

Expected result:

```text
... State: running ...
```

If that fails, use [Windows troubleshooting](/platforms/windows-troubleshooting#wsl2-is-installed-but-systemd-is-disabled).

### 3. Install OpenClaw inside WSL

Follow the Linux setup inside WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw onboard
```

Related docs:

- [Getting started](/start/getting-started)
- [Gateway CLI](/cli/gateway)
- [Doctor CLI](/cli/doctor)

### 4. Install the Gateway service

Inside WSL:

```bash
openclaw gateway install
openclaw gateway status --deep
```

Expected result:

```text
Service: loaded
Runtime: running
RPC probe: ok
```

### 5. Optional boot chain before Windows sign-in

If the Gateway must start before Windows login:

1. Enable linger inside WSL:

```bash
sudo loginctl enable-linger "$(whoami)"
```

2. Keep the WSL Gateway user service installed:

```bash
openclaw gateway install
```

3. Wake WSL at Windows boot from an elevated PowerShell window:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu-24.04 --exec /bin/true" /sc onstart /ru SYSTEM
```

Replace `Ubuntu-24.04` with the distro from:

```powershell
wsl --list --verbose
```

## Quickstart with native Windows

### 1. Run the installer

In PowerShell:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Expected result:

```text
[OK] Node.js v22.x found
[OK] npm vx.y.z found
[OK] OpenClaw installed
[OK] Verified OpenClaw CLI: 2026.x.x
```

What to do next:

- Run `openclaw onboard` for first-time setup.
- If the installer says WSL2 is missing, that is advisory, not a hard failure.
- If the installer fails with file-lock or PATH guidance, go to [Windows troubleshooting](/platforms/windows-troubleshooting#install-or-update-fails-with-a-file-lock-busy-file-or-access-denied-error).

### 2. Complete first run

```powershell
openclaw onboard
```

If you only want the CLI first:

```powershell
openclaw onboard --non-interactive --skip-health
```

### 3. Install managed Gateway startup

```powershell
openclaw gateway install
```

OpenClaw tries a **Scheduled Task** first. If Windows blocks that path, it falls back to a **Startup folder** login item for the current user.

Check what happened:

```powershell
openclaw gateway status --json
```

Look for these fields:

```json
{
  "windows": {
    "serviceMode": "scheduled-task",
    "registrationDetail": "Scheduled Task is registered as OpenClaw Gateway.",
    "logDir": "C:\\Users\\you\\.openclaw\\logs\\gateway"
  }
}
```

### 4. Optional tray companion

The repo includes a native Windows tray companion MVP under `apps/windows/`.

Build it from the repo root:

```powershell
pnpm windows:tray:build
```

Run it:

```powershell
dotnet run --project apps/windows/OpenClaw.WindowsTray/OpenClaw.WindowsTray.csproj
```

The tray menu can:

- show the current Gateway state
- start, stop, and restart the Gateway
- open the logs folder
- open the Windows docs
- enable or disable tray launch at login

The tray app shows `degraded` when:

- the CLI is not available to the tray process
- `openclaw gateway status --json` exceeds the tray timeout budget or returns invalid JSON
- the Gateway is running but the health probe is failing
- the CLI reports a Windows degraded reason such as Startup-folder fallback

For a deterministic, noninteractive verification run:

```powershell
pnpm windows:tray:verify
```

That flow builds the tray app and exercises:

- `status --json`
- `start --json`
- `stop --json`
- `restart --json`
- tray smoke JSON output

See [apps/windows/README.md](https://github.com/openclaw/openclaw/blob/main/apps/windows/README.md) in the repo for local build details.

## Status, stop, restart, and logs

### Check status

Quick text view:

```powershell
openclaw gateway status
```

Machine-readable view:

```powershell
openclaw gateway status --json
```

Deeper diagnostic view:

```powershell
openclaw gateway status --deep
```

### Stop or restart

```powershell
openclaw gateway stop
openclaw gateway start
openclaw gateway restart
```

### Run doctor

```powershell
openclaw doctor
```

On Windows, doctor now reports:

- whether WSL2 is installed and reachable
- whether `systemd` is enabled in the default WSL distro
- whether the Gateway is using a Scheduled Task or Startup-folder fallback
- where the Gateway logs live
- what action to take next when the state is degraded

If the tray app or doctor says `degraded`, the message should tell you whether the issue is CLI access, startup registration, WSL readiness, or an unhealthy Gateway probe.

### Find logs

Native Windows status output includes the log directory, stdout log, and stderr log:

```powershell
openclaw gateway status
```

Expected fields:

```text
Gateway logs:   C:\Users\you\.openclaw\logs\gateway
Gateway stdout: C:\Users\you\.openclaw\logs\gateway\gateway.out.log
Gateway stderr: C:\Users\you\.openclaw\logs\gateway\gateway.err.log
```

Related docs:

- [Gateway logging](/gateway/logging)
- [Gateway troubleshooting](/gateway/troubleshooting)

## Common recovery flows

### Gateway is registered but unhealthy

Run:

```powershell
openclaw gateway status --deep
openclaw doctor
openclaw gateway restart
```

If status says the Gateway is running but the port is not listening:

1. Open the stdout and stderr log paths from `openclaw gateway status`.
2. Run `openclaw doctor`.
3. Reinstall the startup entry if the task script is missing:

```powershell
openclaw gateway install --force
```

### Scheduled Task creation was denied

If `serviceMode` is `startup-fallback`, OpenClaw is still usable.

Next step options:

- Keep the Startup-folder fallback if per-user login startup is enough.
- Re-run `openclaw gateway install` from an elevated PowerShell session if you want Scheduled Task supervision.

### You want to switch from native Windows to WSL2

1. Install WSL2 and enable `systemd`.
2. Install OpenClaw inside WSL.
3. Re-run onboarding and `openclaw gateway install` inside WSL.
4. Use native Windows only for the tray companion if you still want it.

## Advanced: expose WSL services over LAN

If another machine needs to reach a service inside WSL, forward a Windows port to the current WSL IP.

Run from an elevated PowerShell window:

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Use the Windows host IP from another machine:

```text
ssh user@windows-host -p 2222
```

If WSL restarts, refresh the portproxy rule with the new WSL IP.
