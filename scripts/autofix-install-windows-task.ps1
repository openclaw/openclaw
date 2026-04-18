# Register the OpenClaw PR Autofix scheduled task on Windows.
#
# Usage (from a regular or elevated PowerShell):
#   cd C:\OpenClaw
#   .\scripts\autofix-install-windows-task.ps1
#   .\scripts\autofix-install-windows-task.ps1 -IntervalMinutes 5
#   .\scripts\autofix-install-windows-task.ps1 -Repo myorg/myrepo -PrNumber 42
#
# What it does:
#   * Registers a per-user scheduled task named "OpenClaw PR Autofix".
#   * Trigger 1: fires when you log in (so the `claude login` session in
#     ~/.claude/ and user env are accessible).
#   * Trigger 2: repeats every N minutes (default 10) for as long as
#     you're logged in, for up to one year before the trigger expires.
#   * Action: invokes scripts/autofix-loop.ps1 which runs autofix.py
#     once and exits.
#
# Re-running overwrites any existing task with the same name. To remove
# the task entirely, run scripts/autofix-uninstall-windows-task.ps1.
#
# One-time prerequisite: set your GitHub PAT in the user environment:
#   setx GITHUB_TOKEN "<your PAT with repo scope>"
# Then sign out + back in so the env var is visible to newly-spawned
# tasks.

param(
    [string]$Repo = "openclaw/openclaw",
    [int]$PrNumber = 68135,
    [int]$IntervalMinutes = 10,
    [string]$TaskName = "OpenClaw PR Autofix"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$LauncherPath = Join-Path $RepoRoot "scripts\autofix-loop.ps1"
$HiddenWrapperPath = Join-Path $RepoRoot "scripts\autofix-loop-hidden.vbs"

if (-not (Test-Path $LauncherPath)) {
    Write-Error "Launcher not found at $LauncherPath"
    exit 1
}
if (-not (Test-Path $HiddenWrapperPath)) {
    Write-Error "Hidden wrapper not found at $HiddenWrapperPath"
    exit 1
}

# Warn if GITHUB_TOKEN isn't set in user env.
$TokenCheck = [System.Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User")
if (-not $TokenCheck) {
    Write-Warning "GITHUB_TOKEN is not set in your user environment."
    Write-Warning "The task will install, but every run will fail until you run:"
    Write-Warning '  setx GITHUB_TOKEN "<your PAT with repo scope>"'
    Write-Warning "in cmd, then sign out + back in."
}

# Task action: invoke the VBScript wrapper via wscript.exe, which in
# turn launches autofix-loop.ps1 with WindowStyle=Hidden. wscript +
# .vbs is the only combo that reliably avoids a console-window flash
# on every 10-minute firing -- `powershell -WindowStyle Hidden` still
# briefly shows a console because the OS allocates it before PS can
# suppress it. Args after the .vbs path are forwarded verbatim to the
# PS launcher.
#
# Built as a single string to sidestep PowerShell's quote-escape
# parsing on multi-arg lines.
$WrapperArg = '"' + $HiddenWrapperPath + '" -Repo "' + $Repo + '" -PrNumber ' + $PrNumber

$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $WrapperArg -WorkingDirectory $RepoRoot

# Build two triggers so the task runs reliably whether the user is
# already logged in at registration time, or logs in later:
#
#  * OnceTrigger - fires 1 minute from NOW, then repeats every N min
#    for 1 year. This is the primary driver of the autonomy loop; it
#    doesn't depend on a logon event, so NextRunTime populates
#    immediately on registration.
#
#  * LogonTrigger - fires on each user logon, also with repetition.
#    Belt-and-suspenders for post-reboot / re-login scenarios, and
#    ensures the task keeps running even if the Once trigger's window
#    ever closes.
$Repeat = New-TimeSpan -Minutes $IntervalMinutes
$RepeatFor = New-TimeSpan -Days 365
$StartAt = (Get-Date).AddMinutes(1)
$OnceTrigger = New-ScheduledTaskTrigger -Once -At $StartAt -RepetitionInterval $Repeat -RepetitionDuration $RepeatFor
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$LogonTrigger.Repetition = $OnceTrigger.Repetition

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$Description = "Runs autofix.py against the configured OpenClaw PR every $IntervalMinutes minutes. See scripts/autofix-loop.ps1."
$Task = New-ScheduledTask -Action $Action -Trigger @($OnceTrigger, $LogonTrigger) -Settings $Settings -Principal $Principal -Description $Description

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Existing task '$TaskName' found - replacing."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -InputObject $Task | Out-Null

$LogDir = Join-Path $env:USERPROFILE ".openclaw\autofix"

Write-Host ""
Write-Host "[OK] Registered scheduled task: $TaskName"
Write-Host "  Target:    $Repo PR #$PrNumber"
Write-Host "  Interval:  every $IntervalMinutes minutes, starting at login"
Write-Host "  Launcher:  $LauncherPath"
Write-Host "  Logs:      $LogDir\autofix-<date>.log"
Write-Host ""
Write-Host "Run now to verify:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Check status:"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  .\scripts\autofix-uninstall-windows-task.ps1"
