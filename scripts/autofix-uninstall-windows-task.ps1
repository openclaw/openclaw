# Unregister the OpenClaw PR Autofix scheduled task.
#
# Usage:
#   .\scripts\autofix-uninstall-windows-task.ps1
#
# Also clears the running lock file (in case a run was mid-flight)
# and reports on any logs left behind. Does NOT delete the log files
# themselves — those live under ~/.openclaw/autofix/ and you can keep
# or prune them manually.

param(
    [string]$TaskName = "OpenClaw PR Autofix"
)

$ErrorActionPreference = "Stop"

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✓ Unregistered task: $TaskName"
} else {
    Write-Host "Task '$TaskName' was not registered; nothing to do."
}

# Clean up any stale lock file so the task can be re-registered cleanly.
$LockFile = Join-Path $env:USERPROFILE ".openclaw\autofix\autofix.lock"
if (Test-Path $LockFile) {
    Remove-Item $LockFile -Force
    Write-Host "✓ Removed lock file: $LockFile"
}

# Report on logs without deleting.
$LogDir = Join-Path $env:USERPROFILE ".openclaw\autofix"
if (Test-Path $LogDir) {
    $LogCount = (Get-ChildItem -Path $LogDir -Filter "autofix-*.log" -ErrorAction SilentlyContinue).Count
    if ($LogCount -gt 0) {
        Write-Host ""
        Write-Host "Kept $LogCount autofix log file(s) in $LogDir"
        Write-Host "Delete with: Remove-Item $LogDir -Recurse -Force"
    }
}
