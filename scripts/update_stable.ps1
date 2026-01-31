$ErrorActionPreference = "Stop"

Write-Host "🦞 Moltbot Stable Updater" -ForegroundColor Cyan
Write-Host "Checking for stable updates..."

# Ensure we are in the right directory (script location's parent)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

# Run the official update command
# usage: node moltbot.mjs update --channel stable --yes
# --yes skips confirmation for downgrades/changes (useful for automation)
try {
    node moltbot.mjs update --channel stable --yes
    Write-Host "✅ Update check/execution complete." -ForegroundColor Green
} catch {
    Write-Host "❌ Update failed." -ForegroundColor Red
    Write-Error $_
}
