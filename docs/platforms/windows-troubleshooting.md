---
summary: "Windows troubleshooting for WSL2, native installs, Scheduled Tasks, Startup fallback, logs, and recovery"
read_when:
  - Gateway install or startup fails on Windows
  - WSL2 is missing or not ready
  - The Windows tray or doctor output shows a degraded state
title: "Windows troubleshooting"
---

# Windows troubleshooting

Use this page when a Windows install, Gateway startup, or tray action fails.

Start with:

```powershell
openclaw gateway status --deep
openclaw doctor
```

Those commands tell you:

- whether WSL2 exists and the default distro is reachable
- whether `systemd` is enabled inside WSL
- whether the Gateway uses a Scheduled Task or Startup-folder fallback
- where the logs are
- what OpenClaw recommends next

## Quick decision tree

### Installer failed before `openclaw --version`

- If the error mentions `EPERM`, `EBUSY`, or access denied, go to [File lock or access denied](#install-or-update-fails-with-a-file-lock-busy-file-or-access-denied-error).
- If the error says a command was not found, go to [PATH or command not found](#openclaw-node-npm-or-git-is-not-recognized).
- If the error mentions execution policy, go to [Execution policy blocked npmps1](#powershell-execution-policy-blocks-npmps1).

### Gateway install succeeded, but background startup is degraded

- If `serviceMode` is `startup-fallback`, go to [Scheduled Task denied or missing](#scheduled-task-creation-was-denied-or-the-task-is-missing).
- If status says the task script is missing, go to [Missing task script](#gateway-startup-entry-points-at-a-missing-script).
- If the process says running but the port is not listening, go to [Gateway running but no listener](#gateway-claims-running-but-the-port-is-not-listening).

### WSL2 path is broken

- If `wsl.exe` is missing, go to [WSL2 missing](#wsl2-is-not-installed).
- If the distro is installed but not ready, go to [Default distro not ready](#wsl2-is-installed-but-the-default-distro-is-not-ready).
- If `systemd` is disabled, go to [systemd disabled](#wsl2-is-installed-but-systemd-is-disabled).

## Install or update fails with a file lock, busy file, or access denied error

Symptoms:

```text
EPERM
EBUSY
access is denied
being used by another process
resource busy
```

What happened:

- Another PowerShell session, editor, antivirus scan, or background process is holding the OpenClaw install path.

What to do now:

1. Close other shells or editors using `openclaw`.
2. Wait a few seconds and rerun the installer.
3. If it still fails, restart PowerShell or Windows.
4. Retry:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

## `openclaw`, `node`, `npm`, or `git` is not recognized

Symptoms:

```text
The term 'openclaw' is not recognized...
```

What happened:

- PATH is stale in the current shell, or the tool is not installed.

What to do now:

1. Open a fresh PowerShell window.
2. Check the dependency directly:

```powershell
node --version
npm --version
git --version
openclaw --version
```

3. If `openclaw` is the only missing command, reinstall:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

## PowerShell execution policy blocks npmps1

Symptoms:

```text
running scripts is disabled on this system
```

What happened:

- PowerShell execution policy blocked npm's PowerShell wrapper.

What to do now:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
```

Then rerun the installer or the failed command.

If your organization manages execution policy centrally, use WSL2 instead of forcing local policy changes.

## WSL2 is not installed

Symptoms:

- `openclaw doctor` says WSL2 is not installed.
- `wsl.exe` fails or is missing.

What to do now:

```powershell
wsl --install
```

Then reboot Windows and launch the distro once.

Use [Windows](/platforms/windows) for the full WSL2 quickstart.

## WSL2 is installed, but the default distro is not ready

Symptoms:

- doctor says the default distro is not reachable
- `wsl -e sh -lc "printf ok"` fails

What happened:

- The distro exists but first-run setup never completed, or it is in a broken state.

What to do now:

1. List distros:

```powershell
wsl --list --verbose
```

2. Start the default distro manually and finish first-run setup.
3. If needed, install a fresh distro:

```powershell
wsl --install -d Ubuntu-24.04
```

## WSL2 is installed, but `systemd` is disabled

Symptoms:

- doctor says the default distro is reachable, but `systemd` is disabled
- `openclaw gateway install` inside WSL does not behave like a normal user service

What to do now:

Inside WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

From PowerShell:

```powershell
wsl --shutdown
```

Then reopen WSL and verify:

```bash
systemctl --user status
```

## Scheduled Task creation was denied or the task is missing

Symptoms:

- `serviceMode` is `startup-fallback`
- doctor mentions Startup-folder fallback
- `schtasks` never created the Gateway task

What happened:

- Windows blocked Scheduled Task creation, or the task was removed later.

What to do now:

1. Check the current mode:

```powershell
openclaw gateway status --json
```

2. If Startup-folder fallback is acceptable, do nothing.
3. If you want Scheduled Task supervision, re-run from an elevated PowerShell window:

```powershell
openclaw gateway install
```

4. Verify:

```powershell
schtasks /Query /TN "OpenClaw Gateway"
openclaw gateway status
```

## Startup-folder fallback is installed, but nothing starts after login

Symptoms:

- `serviceMode` is `startup-fallback`
- the Gateway only starts when launched manually

What happened:

- The Startup-folder entry exists, but the task script or login startup behavior is broken.

What to do now:

1. Inspect the startup entry path from `openclaw gateway status`.
2. Recreate the startup entry:

```powershell
openclaw gateway install --force
```

3. Sign out and back in, then run:

```powershell
openclaw gateway status
```

## Gateway startup entry points at a missing script

Symptoms:

- status or doctor reports a missing task script

What happened:

- The Scheduled Task or Startup-folder entry still exists, but the generated script under the OpenClaw state directory was removed.

What to do now:

```powershell
openclaw gateway install --force
```

Then verify:

```powershell
openclaw gateway status --deep
```

## Gateway claims running, but the port is not listening

Symptoms:

- status reports the runtime as running
- doctor or status says the configured port is not listening
- RPC probe fails

What happened:

- The supervisor believes the process is alive, but the Gateway crashed early or never reached a healthy listener.

What to do now:

1. Read the log paths from `openclaw gateway status`.
2. Run:

```powershell
openclaw doctor
openclaw gateway restart
```

3. Recheck:

```powershell
openclaw gateway status --deep
```

If the port is still missing, move to WSL2 for the Gateway host.

## Gateway starts, then exits

Symptoms:

- `openclaw gateway start` works briefly
- logs show early crashes or repeated restarts

What to do now:

1. Run:

```powershell
openclaw gateway status
```

2. Open:

- `Gateway stdout`
- `Gateway stderr`

3. Then run:

```powershell
openclaw doctor
```

Look for:

- config errors
- port collisions
- missing credentials
- plugin or runtime exceptions

## Port, firewall, or permission problems

Symptoms:

- local Gateway commands work, but remote access does not
- a LAN or WSL-exposed port cannot be reached

What to do now:

1. Confirm what port OpenClaw expects:

```powershell
openclaw gateway status --deep
```

2. If you are exposing a WSL service, re-check the current WSL IP and your `netsh interface portproxy` rule.
3. If Windows Firewall is the blocker, add an inbound rule for the port you actually use.

Example:

```powershell
New-NetFirewallRule -DisplayName "OpenClaw Gateway 18789" -Direction Inbound -Protocol TCP -LocalPort 18789 -Action Allow
```

## Logs or status paths are missing

Symptoms:

- `openclaw gateway status` cannot show log paths
- the tray app cannot open logs

What to do now:

1. Reinstall the Gateway startup artifacts:

```powershell
openclaw gateway install --force
```

2. Recheck:

```powershell
openclaw gateway status
```

3. If paths are still missing, use:

```powershell
openclaw doctor
```

## Tray app cannot control the Gateway

Symptoms:

- the tray app shows a degraded state immediately
- start, stop, or restart fails from the tray menu
- the tray app says the CLI timed out while reading gateway status

What happened:

- The tray app shells out to `openclaw gateway status --json`, `start`, `stop`, and `restart`. If the CLI is missing or broken, the tray app will also fail.
- If the status call hangs or exceeds the tray timeout budget, the tray app now reports that timeout instead of silently waiting.

What to do now:

1. Verify the CLI outside the tray app:

```powershell
openclaw --version
openclaw gateway status --json
```

2. If the CLI is not on PATH, reinstall OpenClaw or launch the tray app from a shell where `openclaw` already works.
3. If you built the tray app from the repo, rebuild it:

```powershell
pnpm windows:tray:build
```

4. If you want a deterministic local validation run without a live Gateway:

```powershell
pnpm windows:tray:verify
```

## Still stuck

Collect a clean local bundle before escalating:

```powershell
openclaw gateway status --deep
openclaw doctor
```

Keep the stdout and stderr log paths from status output. Those three artifacts are the fastest way to tell whether the issue is install, startup registration, or runtime health.
