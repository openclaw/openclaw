# Register the OpenClaw PR Autofix scheduled task on Windows.
#
# Usage (from an elevated OR regular PowerShell in the repo root):
#   .\scripts\autofix-install-windows-task.ps1
#   .\scripts\autofix-install-windows-task.ps1 -IntervalMinutes 5
#   .\scripts\autofix-install-windows-task.ps1 -Repo myorg/myrepo -PrNumber 42
#
# What it does:
#   * Registers a per-user scheduled task named "OpenClaw PR Autofix".
#   * Trigger 1: fires when you log in (so the `claude login` session
#     in ~/.claude/ is accessible — boot triggers wouldn't have it).
#   * Trigger 2: repeats every N minutes (default 10) for as long as
#     you're logged in, indefinitely.
#   * Action: invokes `scripts/autofix-loop.ps1` which runs `autofix.py`
#     once and exits.
#
# Re-running this script overwrites any existing task with the same
# name. To remove the task entirely, run the paired
# `autofix-uninstall-windows-task.ps1`.
#
# One-time prerequisite: set your GitHub PAT in the user environment:
#   setx GITHUB_TOKEN "<your PAT with repo scope>"
# Then sign out + back in (or reboot) so the env var is picked up by
# newly-spawned tasks.

param(
    [string]$Repo = "openclaw/openclaw",
    [int]$PrNumber = 68135,
    [int]$IntervalMinutes = 10,
    [string]$TaskName = "OpenClaw PR Autofix"
)

$ErrorActionPreference = "Stop"

$RepoRoot = "C:\OpenClaw"
$LauncherPath = Join-Path $RepoRoot "scripts\autofix-loop.ps1"

if (-not (Test-Path $LauncherPath)) {
    Write-Error "Launcher not found at $LauncherPath"
    exit 1
}

# Warn if GITHUB_TOKEN isn't set in user env — the task will install
# fine but fail at runtime without it.
$TokenCheck = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")
if (-not $TokenCheck) {
    Write-Warning "GITHUB_TOKEN is not set in your user environment."
    Write-Warning "The task will install, but every run will fail until you run:"
    Write-Warning "  setx GITHUB_TOKEN ""<your PAT with repo scope>"""
    Write-Warning "…in cmd, then sign out + back in."
}

# Action: run PowerShell against the launcher script, with bypassed
# execution policy scoped to this invocation only.
$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`" -Repo `"$Repo`" -PrNumber $PrNumber" `
    -WorkingDirectory $RepoRoot

# Triggers:
#   1. AtLogOn of the current user (not AtStartup — we need the user
#      session to be alive so ~/.claude/ and user env are available).
#   2. Repeat every N minutes forever once the user is logged in.
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Repeat = New-TimeSpan -Minutes $IntervalMinutes
$RepeatFor = New-TimeSpan -Days 365
$LogonTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval $Repeat -RepetitionDuration $RepeatFor).Repetition

# Settings: allow retry if the machine is busy, don't block parallel
# instances (the launcher itself has a file-lock against overlap),
# and don't run when on battery to save power.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# Principal: run as current interactive user (no admin elevation).
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$Task = New-ScheduledTask `
    -Action $Action `
    -Trigger $LogonTrigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Runs autofix.py against the configured OpenClaw PR every $IntervalMinutes minutes. See scripts/autofix-loop.ps1."

# Overwrite any existing registration with the same name.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Existing task '$TaskName' found — replacing."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -InputObject $Task | Out-Null

Write-Host ""
Write-Host "✓ Registered scheduled task: $TaskName"
Write-Host "  Target: $Repo PR #$PrNumber"
Write-Host "  Interval: every $IntervalMinutes minutes, starting at login"
Write-Host "  Launcher: $LauncherPath"
Write-Host "  Logs: $env:USERPROFILE\.openclaw\autofix\autofix-<date>.log"
Write-Host ""
Write-Host "Run now to verify:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Check status:"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  .\scripts\autofix-uninstall-windows-task.ps1"
