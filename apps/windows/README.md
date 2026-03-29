# Windows companion app

This directory contains the native Windows tray companion MVP for OpenClaw.

## What it does

The tray app is a small WinForms background process that polls:

```text
openclaw gateway status --json
```

It uses the existing CLI for all Gateway control actions:

- `openclaw gateway start --json`
- `openclaw gateway stop --json`
- `openclaw gateway restart --json`

From the tray menu you can:

- see the current Gateway state (`running`, `stopped`, or `degraded`)
- start, stop, and restart the Gateway
- open the logs folder
- open the config folder
- copy a diagnostics summary
- open the Windows quickstart and troubleshooting docs
- enable or disable tray launch at login

The tray app shows `degraded` when:

- the CLI cannot be found from the tray process
- `openclaw gateway status --json` does not return within the tray timeout budget or fails
- the CLI returns a Windows degraded reason such as Startup-folder fallback
- the Gateway process is running but the health probe is failing

## Build

From the repo root:

```powershell
pnpm windows:tray:build
```

Or directly:

```powershell
dotnet build apps/windows/OpenClaw.WindowsTray/OpenClaw.WindowsTray.csproj
```

## Run

```powershell
dotnet run --project apps/windows/OpenClaw.WindowsTray/OpenClaw.WindowsTray.csproj
```

The app runs as a tray-only process with no main window. Double-clicking the tray icon copies a diagnostics summary to the clipboard.

## Smoke check

The project includes a noninteractive smoke mode:

```powershell
pnpm windows:tray:smoke
```

That mode resolves the OpenClaw CLI, runs `openclaw gateway status --json`, and prints a JSON summary that CI or local validation can consume.

To persist the smoke result as JSON:

```powershell
dotnet run --project apps/windows/OpenClaw.WindowsTray/OpenClaw.WindowsTray.csproj -- --smoke --smoke-output .\tray-smoke.json
Get-Content .\tray-smoke.json
```

To run a deterministic fixture-based verification that exercises `status`, `start`, `stop`, and `restart` without a live Gateway:

```powershell
pnpm windows:tray:verify
```

## Noninteractive validation modes

These modes exist to make local validation and CI-style checks easier:

```powershell
OpenClaw.WindowsTray.exe --status-json --output .\status.json
OpenClaw.WindowsTray.exe --lifecycle-json restart --output .\restart.json
OpenClaw.WindowsTray.exe --smoke --output .\smoke.json
```

## CLI resolution

The tray app looks for the CLI in this order:

1. `OPENCLAW_TRAY_OPENCLAW_PATH`
2. `openclaw.cmd`, `openclaw.exe`, or `openclaw` on PATH
3. `node dist/index.js` when the repo has already been built
4. `node scripts/run-node.mjs` as the last repo-local development fallback

If you need to point the tray app at a specific CLI build, set:

```powershell
$env:OPENCLAW_TRAY_OPENCLAW_PATH = "C:\path\to\openclaw.cmd"
```

## Launch at login

The tray app stores its autostart entry under:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

The toggle lives in the tray menu as **Launch companion at login**.
